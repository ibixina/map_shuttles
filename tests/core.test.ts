import { describe, expect, it } from 'vitest';
import routes from './fixtures/routes.json';
import schedule from './fixtures/schedule.json';
import places from '../src/data/places.json';
import { buildBuses, liveArrivals, type RawLocation, type RawVelocity } from '../src/lib/live';
import { buildNetwork, pathBetween, stopsBetween, type RawRoutes } from '../src/lib/network';
import { estimateWalk, planTrips, type Endpoint, type RideLeg } from '../src/lib/planner';
import { LocalIndex, mergeResults, normalize, type Place, type RawPlace } from '../src/lib/search';
import { dayLabel, DAY, formatTime, parseClockTime, Timetable, troyClock } from '../src/lib/time';
import { decodePolyline6, stepsFromOsrm, stepsFromValhalla } from '../src/lib/walking';
import { createHandler } from '../worker/live-proxy.mjs';
import { lineColor, minimalStyle } from '../src/lib/basemap';

const network = buildNetwork(routes as unknown as RawRoutes);
const stop = (routeId: string, key: string) => network.stopById.get(`${routeId}:${key}`)!;
// Weekdays: Wednesday 4 November 2026, noon in Troy.
const WEDNESDAY_NOON = troyClock(new Date('2026-11-04T17:00:00Z'));
const timetable = new Timetable(schedule, WEDNESDAY_NOON);
const plan = (from: Endpoint, to: Endpoint, startMin = WEDNESDAY_NOON.minutes, tt = timetable) =>
  planTrips({ from, to, startMin, network, timetable: tt, walk: estimateWalk });
const named = (s: { lat: number; lng: number }, name: string): Endpoint => ({ lat: s.lat, lng: s.lng, name });

describe('network', () => {
  it('keeps passenger routes and drops transparent deadhead runs', () => {
    expect(network.routes.map((r) => r.id)).toEqual(['NORTH', 'WEST']);
  });

  it('excludes ghost waypoints from boardable stops', () => {
    const keys = network.boardingStops.map((s) => s.key);
    expect(keys).not.toContain('GHOST_STOP_1');
    expect(keys).not.toContain('STUDENT_UNION_RETURN');
    expect(keys).toContain('STUDENT_UNION');
  });

  it('has one polyline leg between each pair of real stops, ending at those stops', () => {
    for (const route of network.routes) {
      expect(route.legs.length).toBe(route.stops.length - 1);
      route.legs.forEach((leg, i) => {
        const at = ([lng, lat]: [number, number]) => ({ lat, lng });
        expect(estimateWalk(at(leg[0]), route.stops[i]).meters).toBeLessThan(120);
        expect(estimateWalk(at(leg[leg.length - 1]), route.stops[i + 1]).meters).toBeLessThan(120);
      });
    }
  });

  it('has stop times that never run backwards', () => {
    for (const route of network.routes) {
      for (let i = 1; i < route.stops.length; i++) {
        expect(route.stops[i].offset).toBeGreaterThanOrEqual(route.stops[i - 1].offset);
      }
    }
  });

  it('gives a continuous path and the stops passed between two stops', () => {
    const west = network.routeById.get('WEST')!;
    const from = stop('WEST', 'ACADEMY_HALL');
    const to = stop('WEST', 'BLITMAN');
    const path = pathBetween(west, from, to);
    expect(path.length).toBeGreaterThan(10);
    expect(estimateWalk({ lat: path[0][1], lng: path[0][0] }, from).meters).toBeLessThan(120);
    expect(estimateWalk({ lat: path.at(-1)![1], lng: path.at(-1)![0] }, to).meters).toBeLessThan(120);
    expect(stopsBetween(west, from, to).map((s) => s.key)).toEqual(['POLYTECHNIC', 'CITY_STATION']);
  });
});

describe('time', () => {
  it('reads Troy time whatever the machine zone, across daylight saving', () => {
    expect(troyClock(new Date('2026-07-01T16:30:00Z')).minutes).toBe(12 * 60 + 30);
    expect(troyClock(new Date('2026-12-01T17:30:00Z')).minutes).toBe(12 * 60 + 30);
    expect(troyClock(new Date('2026-11-04T17:00:00Z')).weekdayIndex).toBe(3);
  });

  it('treats just-after-midnight departures as the end of the previous day', () => {
    expect(parseClockTime('12:00 AM')).toBe(DAY);
    expect(parseClockTime('12:10 PM')).toBe(730);
    expect(parseClockTime('7:25 PM')).toBe(19 * 60 + 25);
    expect(parseClockTime('garbage')).toBeNull();
    expect(formatTime(DAY)).toBe('12:00 AM');
    expect(formatTime(730)).toBe('12:10 PM');
  });

  it("finds a route's next departure and merges every bus's runs", () => {
    expect(timetable.next('WEST', 7 * 60 + 1)).toBe(7 * 60 + 10);
    expect(timetable.next('WEST', 7 * 60)).toBe(7 * 60);
  });

  it('rolls over to the next service day after the last bus', () => {
    // Sunday night: last departures are 8:00 PM, Monday starts at 7:00 AM.
    const sunday = troyClock(new Date('2026-11-02T01:30:00Z')); // 8:30 PM Sunday
    expect(sunday.weekdayIndex).toBe(0);
    const tt = new Timetable(schedule, sunday);
    const next = tt.next('WEST', sunday.minutes)!;
    expect(next).toBe(DAY + 7 * 60);
    expect(dayLabel(next, sunday)).toBe('Tomorrow');
  });

  it("still offers last night's midnight run in the small hours", () => {
    // 11:58 PM Wednesday: the 12:00 AM run is two minutes away.
    const late = troyClock(new Date('2026-11-05T04:58:00Z'));
    expect(new Timetable(schedule, late).next('WEST', late.minutes)).toBe(DAY);
    // And at 12:00:00 AM Thursday it is counted as minute 0 of the new day.
    const midnight = troyClock(new Date('2026-11-05T05:00:00Z'));
    expect(midnight.weekdayIndex).toBe(4);
    expect(new Timetable(schedule, midnight).next('WEST', midnight.minutes)).toBe(0);
  });

  it('reports service hours for the day', () => {
    const hours = timetable.serviceHours('WEST')!;
    expect(formatTime(hours.first)).toBe('7:00 AM');
    expect(formatTime(hours.last)).toBe('12:00 AM');
  });
});

describe('planner', () => {
  const union = { lat: 42.7299, lng: -73.6766 };

  it('rides a single route for a long trip along it', () => {
    const result = plan(named(union, 'Union'), named(stop('NORTH', 'STAC_2'), 'Stacwyck'));
    const best = result.trips.find((t) => t.kind === 'shuttle')!;
    const rides = best.legs.filter((l): l is RideLeg => l.kind === 'ride');
    expect(rides.length).toBe(1);
    expect(rides[0].routeId).toBe('NORTH');
    expect(rides[0].alight.key).toBe('STAC_2');
  });

  it('never rides backwards around a one-way loop', () => {
    const result = plan(named(stop('WEST', 'BLITMAN'), 'A'), named(stop('WEST', 'ACADEMY_HALL'), 'B'));
    for (const trip of result.trips) {
      for (const leg of trip.legs) {
        if (leg.kind === 'ride') expect(leg.alight.index).toBeGreaterThan(leg.board.index!);
      }
    }
  });

  it('changes at the Student Union to cross between the two loops', () => {
    const result = plan(named(stop('NORTH', 'STAC_2'), 'Stacwyck'), named(stop('WEST', 'CITY_STATION'), 'City Station'));
    const change = result.trips.find((t) => t.hasTransfer);
    expect(change).toBeDefined();
    const rides = change!.legs.filter((l): l is RideLeg => l.kind === 'ride');
    expect(rides[0].routeId).toBe('NORTH');
    expect(rides[1].routeId).toBe('WEST');
    expect(rides[1].departMin).toBeGreaterThanOrEqual(rides[0].arriveMin);
  });

  it('keeps legs in time order and arrives after leaving', () => {
    const result = plan(named(union, 'Union'), named(stop('WEST', 'CHASAN'), 'Chasan'));
    for (const trip of result.trips) {
      expect(trip.arriveMin).toBeGreaterThan(trip.leaveMin);
      let t = trip.leaveMin - 1e-6;
      for (const leg of trip.legs) {
        const start = leg.kind === 'walk' ? leg.startMin : leg.departMin;
        expect(start).toBeGreaterThanOrEqual(t);
        t = leg.kind === 'walk' ? leg.startMin + leg.minutes : leg.arriveMin;
      }
    }
  });

  it('never leaves earlier than asked', () => {
    const result = plan(named(union, 'Union'), named(stop('NORTH', 'ECAV'), 'ECAV'));
    for (const trip of result.trips) expect(trip.leaveMin).toBeGreaterThanOrEqual(WEDNESDAY_NOON.minutes);
  });

  it('allows enough time to walk to the stop before the bus leaves', () => {
    const result = plan(named(union, 'Union'), named(stop('NORTH', 'ECAV'), 'ECAV'));
    for (const trip of result.trips) {
      const [first, second] = trip.legs;
      if (first.kind === 'walk' && second?.kind === 'ride') {
        expect(WEDNESDAY_NOON.minutes + first.minutes).toBeLessThanOrEqual(second.departMin);
      }
    }
  });

  it('prefers plain walking for somewhere next door', () => {
    const result = plan(named(union, 'Union'), { lat: 42.7301, lng: -73.6762, name: 'Next door' });
    expect(result.trips[0].kind).toBe('walk');
    expect(result.trips.every((t) => t.kind === 'walk')).toBe(true);
  });

  it('moves to tomorrow morning when service has ended', () => {
    const late = troyClock(new Date('2026-11-05T05:30:00Z')); // 12:30 AM Thursday
    const tt = new Timetable(schedule, late);
    const result = plan(named(union, 'Union'), named(stop('WEST', 'CITY_STATION'), 'City Station'), late.minutes, tt);
    const shuttle = result.trips.find((t) => t.kind === 'shuttle');
    // Walking is far quicker at this hour, but the morning bus must still be offered.
    expect(shuttle).toBeDefined();
    const ride = shuttle!.legs.find((l): l is RideLeg => l.kind === 'ride')!;
    expect(ride.departMin).toBeGreaterThan(7 * 60 - 1);
  });

  it('plans for a chosen future day using that day\'s schedule', () => {
    // Saturday from a Wednesday clock: no service before 9 AM on Saturdays.
    const saturday8am = 3 * DAY + 8 * 60;
    const result = plan(named(union, 'Union'), named(stop('NORTH', 'STAC_2'), 'Stacwyck'), saturday8am);
    const ride = result.trips.flatMap((t) => t.legs).find((l): l is RideLeg => l.kind === 'ride')!;
    expect(ride.departMin).toBeGreaterThanOrEqual(3 * DAY + 9 * 60);
  });

  it('says the shuttle is no use for a trip far outside its area', () => {
    const albany = { lat: 42.6526, lng: -73.7562, name: 'Albany' };
    const result = plan(named(union, 'Union'), albany);
    expect(result.outOfRange).toBe(true);
    expect(result.trips.filter((t) => t.kind === 'shuttle')).toEqual([]);
  });

  it("doesn't offer changing buses when riding straight there is at least as good", () => {
    const result = plan(named(stop('WEST', 'BLITMAN'), 'Blitman'), named(stop('WEST', 'SAGE_HALL'), 'Sage'));
    expect(result.trips.some((t) => t.kind === 'shuttle' && !t.hasTransfer)).toBe(true);
    expect(result.trips.some((t) => t.hasTransfer)).toBe(false);
  });

  it('skips the walking steps when you are already at the stop', () => {
    const result = plan(named(stop('WEST', 'BLITMAN'), 'Blitman'), named(stop('WEST', 'SAGE_HALL'), 'Sage'));
    const trip = result.trips.find((t) => t.kind === 'shuttle')!;
    expect(trip.legs.map((l) => l.kind)).toEqual(['ride']);
    const ride = trip.legs[0] as RideLeg;
    expect(trip.leaveMin).toBeLessThan(ride.departMin);
    expect(trip.arriveMin).toBe(ride.arriveMin);
    expect(trip.walkMeters).toBe(0);
  });

  it('flags trips that rely on estimated walking times', () => {
    const result = plan(named(union, 'Union'), named(stop('WEST', 'CHASAN'), 'Chasan'));
    expect(result.trips.find((t) => t.kind === 'walk')!.hasEstimatedWalk).toBe(true);
    const measured = planTrips({
      from: named(union, 'Union'), to: named(stop('WEST', 'CHASAN'), 'Chasan'), startMin: WEDNESDAY_NOON.minutes, network, timetable,
      walk: (a, b) => { const { meters, minutes } = estimateWalk(a, b); return { meters, minutes }; },
    });
    expect(measured.trips.find((t) => t.kind === 'walk')!.hasEstimatedWalk).toBe(false);
  });

  it("doesn't warn about a short guessed walk between the two Union stops", () => {
    const trips = plan(named(stop('NORTH', 'STAC_2'), 'Stacwyck'), named(stop('WEST', 'CITY_STATION'), 'City Station')).trips;
    const change = trips.find((t) => t.hasTransfer)!;
    expect(change.legs.some((l) => l.kind === 'walk')).toBe(true);
    expect(change.hasEstimatedWalk).toBe(false);
  });

  it('gives stable trip ids so the selection survives re-planning', () => {
    const a = plan(named(union, 'Union'), named(stop('WEST', 'CHASAN'), 'Chasan')).trips.map((t) => t.id);
    const b = plan(named(union, 'Union'), named(stop('WEST', 'CHASAN'), 'Chasan'), WEDNESDAY_NOON.minutes + 3).trips.map((t) => t.id);
    expect(new Set(b).size).toBe(b.length);
    expect(a.some((id) => b.includes(id))).toBe(true);
  });
});

describe('live buses', () => {
  const NOW = Date.parse('2026-11-01T17:50:00Z');
  const location = (over: Partial<RawLocation> = {}): RawLocation => ({
    name: '450', latitude: 42.7287, longitude: -73.685, timestamp: '2026-11-01T17:49:50Z',
    heading_degrees: 90, speed_mph: 20, address_name: null, ...over,
  });
  const velocity = (over: Partial<RawVelocity> = {}): RawVelocity => ({
    route_name: 'WEST', polyline_index: 4, segment_index: 2, is_at_stop: false, current_stop: null, ...over,
  });

  it('lists upcoming stops with growing estimates', () => {
    const [bus] = buildBuses({ a: location() }, { a: velocity() }, {}, network, NOW);
    expect(bus.state).toBe('on-route');
    const etas = bus.upcoming.map((u) => u.etaMin);
    expect(etas.length).toBeGreaterThan(0);
    expect([...etas].sort((x, y) => x - y)).toEqual(etas);
    expect(liveArrivals(bus.upcoming[0].stop, [bus])[0].bus.id).toBe('a');
  });

  it('prefers official ETAs when the API provides them', () => {
    const [bus] = buildBuses({ a: location() }, { a: velocity() }, { a: { stop_times: { BLITMAN: '2026-11-01T17:53:00Z' } } }, network, NOW);
    const blitman = bus.upcoming.find((u) => u.stop.key === 'BLITMAN');
    if (blitman) expect(blitman.etaMin).toBeCloseTo(3);
  });

  it('marks a bus with no route as idle and shows no arrivals for it', () => {
    const [bus] = buildBuses(
      { a: location({ speed_mph: 0 }) },
      { a: velocity({ route_name: null, polyline_index: null, segment_index: null, is_at_stop: true, current_stop: 'STUDENT_UNION' }) },
      {}, network, NOW,
    );
    expect(bus.state).toBe('idle');
    expect(bus.heading).toBeNull();
    expect(bus.atStopName).toBe('Student Union');
    expect(liveArrivals(stop('WEST', 'BLITMAN'), [bus])).toEqual([]);
  });

  it('labels deadhead runs, flags stale buses, and hides long-silent ones', () => {
    const buses = buildBuses(
      {
        a: location({ name: '1' }),
        b: location({ name: '2', timestamp: '2026-11-01T17:40:00Z' }),
        c: location({ name: '3', timestamp: '2026-11-01T15:00:00Z' }),
      },
      { a: velocity({ route_name: 'ENTRY1' }), b: velocity() },
      {}, network, NOW,
    );
    expect(buses.map((b) => b.name)).toEqual(['1', '2']);
    expect(buses[0].state).toBe('entering');
    expect(buses[1].stale).toBe(true);
    expect(liveArrivals(buses[1].upcoming[0].stop, buses)).toEqual([]);
  });

  it('collects driver and vehicle details for the bus panel', () => {
    const [bus] = buildBuses(
      { a: location({ driver: { id: '9', name: 'Doe, Jane' }, license_plate: 'ABC', vin: 'VIN123', gateway_serial: 'G-1', is_ecu_speed: false, address_name: ' Student Union ' }) },
      {}, {}, network, NOW,
    );
    const value = (label: string) => bus.details.find((d) => d.label === label)?.value;
    expect(value('Driver')).toBe('Doe, Jane');
    expect(value('Driver ID')).toBe('9');
    expect(value('License plate')).toBe('ABC');
    expect(value('VIN')).toBe('VIN123');
    expect(value('Tracker serial')).toBe('G-1');
    expect(value('Zone')).toBe('Student Union');
    expect(value('Speed from engine computer')).toBe('No');
  });

  it('leaves out details the feed does not send, such as a bus with no driver', () => {
    const [bus] = buildBuses({ a: location({ driver: null, vin: null }) }, {}, {}, network, NOW);
    expect(bus.details).toEqual([]);
  });

  it('hides internal zone notes from place names', () => {
    const [bus] = buildBuses({ a: location({ address_name: 'RPI Campus (Idle Geofence)' }) }, {}, {}, network, NOW);
    expect(bus.placeName).toBe('RPI Campus');
  });

  it('copes with a bus missing from the velocity feed', () => {
    const [bus] = buildBuses({ a: location() }, {}, {}, network, NOW);
    expect(bus.state).toBe('idle');
  });
});

describe('search', () => {
  const index = new LocalIndex(places as RawPlace[], network);
  const top = (q: string) => index.search(q)[0]?.name;

  it.each([
    ['DCC', 'Darrin Communications Center'],
    ['dcc', 'Darrin Communications Center'],
    ['EMPAC', 'Experimental Media and Performing Arts Center (EMPAC)'],
    ['barh', 'Burdett Avenue Residence Hall'],
    ['the union', 'Rensselaer Student Union'],
    ['library', 'Folsom Library'],
    ['commons', 'Commons Dining Hall'],
    ['vcc', 'Voorhees Computing Center'],
  ])('finds %s by its everyday name', (query, expected) => {
    expect(top(query)).toBe(expected);
  });

  it('includes both Student Union stops', () => {
    const stops = index.search('student union', 10).filter((p) => p.kind === 'stop');
    expect(stops.map((p) => p.subtitle).sort()).toEqual(['North Route stop', 'West Route stop']);
  });

  it('finds stops and tolerates typos', () => {
    expect(index.search('city station')[0].kind).toBe('stop');
    expect(top('folsum library')).toBe('Folsom Library');
    expect(top('houston feild house')).toContain('Houston Field House');
  });

  it('matches regardless of word order and punctuation', () => {
    expect(top('library folsom')).toBe('Folsom Library');
    expect(normalize("'87 Gym & Pool!")).toBe('87 gym and pool');
  });

  it('returns nothing for empty or nonsense queries', () => {
    expect(index.search('   ')).toEqual([]);
    expect(index.search('qqqzzzxx')).toEqual([]);
  });

  it('every alias in the data resolves to its own place', () => {
    for (const place of places as RawPlace[]) {
      for (const alias of place.aliases ?? []) {
        const results = index.search(alias, 12).map((p) => p.name);
        expect(results, alias).toContain(place.name);
      }
    }
  });

  it('merges remote results without duplicates', () => {
    const p = (name: string): Place => ({ id: name, name, lat: 0, lng: 0, kind: 'poi' });
    expect(mergeResults([p('A')], [p('a'), p('B'), p('B')]).map((x) => x.name)).toEqual(['A', 'B']);
  });

  it('keeps coordinates in the Troy area', () => {
    for (const p of places as RawPlace[]) {
      expect(p.lat).toBeGreaterThan(42.6);
      expect(p.lat).toBeLessThan(42.85);
      expect(p.lng).toBeGreaterThan(-73.8);
      expect(p.lng).toBeLessThan(-73.55);
    }
  });
});

describe('walking directions text', () => {
  it('decodes Valhalla polylines', () => {
    // The standard polyline example, encoded at six decimal places.
    expect(decodePolyline6('_izlhA~rlgdF_{geC~ywl@_kwzCn`{nI')).toEqual([[-120.2, 38.5], [-120.95, 40.7], [-126.453, 43.252]]);
    expect(decodePolyline6('')).toEqual([]);
  });

  it('uses Valhalla instructions, without the arrival line', () => {
    const steps = stepsFromValhalla([
      { instruction: 'Walk south on 6th Avenue.', length: 0.01, type: 2 },
      { instruction: 'Take the stairs.', length: 0.018, type: 39 },
      { instruction: 'You have arrived at your destination.', length: 0, type: 4 },
    ]);
    expect(steps).toEqual([{ text: 'Walk south on 6th Avenue', meters: 10 }, { text: 'Take the stairs', meters: 18 }]);
  });

  it('writes readable steps and folds unnamed fragments', () => {
    const steps = stepsFromOsrm([
      { name: 'Sage Avenue', distance: 100, maneuver: { type: 'depart', modifier: 'right' } },
      { name: '', distance: 20, maneuver: { type: 'continue', modifier: 'straight' } },
      { name: '15th Street', distance: 200, maneuver: { type: 'turn', modifier: 'slight left' } },
      { name: '', distance: 0, maneuver: { type: 'arrive' } },
    ]);
    expect(steps.map((s) => s.text)).toEqual(['Start on Sage Avenue', 'Bear left onto 15th Street']);
    expect(steps[0].meters).toBe(120);
  });
});

describe('live relay', () => {
  const locations = { '1': { name: '412', latitude: 42.73, longitude: -73.67, driver: { name: 'Doe, Jane' } } };
  function fake(respond: (url: string) => unknown = () => locations) {
    const calls: string[] = [];
    let down = false;
    const fn = async (url: string) => {
      calls.push(url);
      if (down) throw new Error('down');
      const body = respond(url);
      return new Response(body instanceof ArrayBuffer ? body : JSON.stringify(body));
    };
    return { fn: fn as typeof fetch, calls, setDown: (v: boolean) => (down = v) };
  }
  const get = (path: string, init: RequestInit = {}) => new Request(`https://relay.test${path}`, init);

  it('combines the shuttle feeds into one response', async () => {
    const f = fake((url) => (url.endsWith('locations') ? locations : url.endsWith('announcements') ? [] : {}));
    const res = await createHandler({ fetchImpl: f.fn })(get('/shuttle'));
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const body = await res.json();
    expect(body.locations['1'].name).toBe('412');
    expect(Object.keys(body).sort()).toEqual(['announcements', 'etas', 'locations', 'velocities']);
    expect(f.calls.length).toBe(4);
  });

  it('refuses anything not on its list, and never reaches upstream for it', async () => {
    const f = fake();
    const handle = createHandler({ fetchImpl: f.fn });
    for (const path of ['/', '/today', '/shuttle/today', '/cdta/../secret', '/constructor', '/__proto__']) {
      expect((await handle(get(path))).status, path).toBe(404);
    }
    expect((await handle(get('/shuttle', { method: 'POST', body: '{}' }))).status).toBe(405);
    expect(f.calls).toEqual([]);
  });

  it('caches within the time limit and refetches after it', async () => {
    let t = 1000;
    const f = fake(() => new ArrayBuffer(4));
    const handle = createHandler({ fetchImpl: f.fn, now: () => t });
    await handle(get('/cdta/vehicles'));
    await handle(get('/cdta/vehicles'));
    expect(f.calls.length).toBe(1);
    t += 13_000;
    await handle(get('/cdta/vehicles'));
    expect(f.calls.length).toBe(2);
  });

  it('shares one upstream request between simultaneous viewers', async () => {
    const f = fake(() => new ArrayBuffer(4));
    const handle = createHandler({ fetchImpl: f.fn });
    await Promise.all([handle(get('/cdta/alerts')), handle(get('/cdta/alerts')), handle(get('/cdta/alerts'))]);
    expect(f.calls.length).toBe(1);
  });

  it('serves the last good copy when upstream fails, and 502 when it has none', async () => {
    let t = 1000;
    const f = fake(() => new ArrayBuffer(4));
    const handle = createHandler({ fetchImpl: f.fn, now: () => t });
    await handle(get('/cdta/vehicles'));
    f.setDown(true);
    t += 60_000;
    expect((await handle(get('/cdta/vehicles'))).status).toBe(200);
    expect((await handle(get('/cdta/trip-updates'))).status).toBe(502);
    expect((await handle(get('/shuttle'))).status).toBe(502);
  });

  it('can be limited to the site that uses it', async () => {
    const f = fake();
    const handle = createHandler({ fetchImpl: f.fn });
    const env = { ALLOWED_ORIGINS: 'https://me.github.io' };
    const ok = await handle(get('/shuttle', { headers: { origin: 'https://me.github.io' } }), env);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://me.github.io');
    expect((await handle(get('/shuttle', { headers: { origin: 'https://other.example' } }), env)).status).toBe(403);
    expect((await handle(get('/shuttle', { method: 'OPTIONS', headers: { origin: 'https://me.github.io' } }), env)).status).toBe(204);
  });
});

describe('map look', () => {
  const style = {
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': 'red' } },
      { id: 'poi_r1', type: 'symbol' },
      { id: 'road_shield_us', type: 'symbol' },
      { id: 'water', type: 'fill', paint: { 'fill-color': 'blue' } },
      { id: 'road_trunk_primary', type: 'line', paint: { 'line-color': 'orange', 'line-width': 3 } },
      { id: 'road_trunk_primary_casing', type: 'line', paint: { 'line-color': 'orange' } },
      { id: 'label_city', type: 'symbol', paint: { 'text-color': 'black' } },
    ],
  };

  it('hides icons and shields and recolors the rest, keeping other paint values', () => {
    const layers = minimalStyle(style).layers as { id: string; layout?: { visibility?: string }; paint?: Record<string, unknown> }[];
    const by = (id: string) => layers.find((l) => l.id === id)!;
    expect(by('poi_r1').layout?.visibility).toBe('none');
    expect(by('road_shield_us').layout?.visibility).toBe('none');
    expect(by('water').paint?.['fill-color']).not.toBe('blue');
    const road = by('road_trunk_primary');
    expect(road.paint?.['line-color']).not.toBe('orange');
    expect(road.paint?.['line-width']).toBe(3);
    expect(by('road_trunk_primary_casing').paint?.['line-color']).not.toBe(road.paint?.['line-color']);
    expect(style.layers[1]).toEqual({ id: 'poi_r1', type: 'symbol' }); // The input isn't changed.
  });

  it('darkens only route colors too pale to see on the map', () => {
    expect(lineColor('#123573')).toBe('#123573');
    expect(lineColor('#d6322c')).toBe('#d6322c');
    expect(lineColor('#fffb00')).not.toBe('#fffb00');
    expect(lineColor('#ffd700')).not.toBe('#ffd700');
    expect(lineColor('not a color')).toBe('not a color');
  });
});
