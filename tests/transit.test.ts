import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import GtfsRealtime from 'gtfs-realtime-bindings';
import routes from './fixtures/routes.json';
import schedule from './fixtures/schedule.json';
import { buildFeed, compactFeed, feedFromCompact, parseGtfsTime, shapeBetween, simplifyLine } from '../src/transit/gtfs.mjs';
import { parseFeedZip } from '../src/transit/gtfs-zip.mjs';
import { decodeFeedMessage } from '../src/transit/gtfsrt.mjs';
import { buildPlanner, parseShuttleTime } from '../src/transit/planner.mjs';
import { buildOverview, indexTripUpdates, listAlerts, listVehicles, routeDetail, stopArrivals, troyNow, vehicleDetail } from '../src/transit/queries.mjs';
import { mergeTrips, type Trip } from '../src/lib/planner';

// A tiny system: route 1 runs A-B-C. Route 2 runs C-D, connecting at C. Route 93 is STAR.
// Wednesday 2026-11-04 is a normal weekday; Thursday 2026-11-05 has route 1 cancelled.
const FILES: Record<string, string> = {
  'routes.txt': [
    'route_id,route_short_name,route_long_name,route_desc,route_color,route_text_color,route_sort_order',
    '1,1,"Main St, Downtown",Desc one,123573,FFFFFF,1',
    '2,2,Second Ave,,FABE04,000000,2',
    '93,93,Star,,123573,FFFFFF,3',
  ].join('\n'),
  'stops.txt': [
    'stop_id,stop_code,stop_name,stop_lat,stop_lon',
    'A,A,Stop A,42.700,-73.700',
    'B,B,Stop B,42.710,-73.700',
    'C,C,Stop C,42.720,-73.700',
    'D,D,Stop D,42.730,-73.700',
    'C2,C2,Stop C across the road,42.7205,-73.7005',
  ].join('\n'),
  'trips.txt': [
    'route_id,service_id,trip_id,trip_headsign,direction_id,shape_id',
    '1,WK,t1,To C,0,s1',
    '1,WK,t2,To C,0,s1',
    '1,WK,late,To C,0,s1',
    '2,WK,t3,To D,0,s2',
    '93,WK,star1,Star,0,s1',
  ].join('\n'),
  'stop_times.txt': [
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type',
    't1,08:00:00,08:00:00,A,1,0,0',
    't1,08:10:00,08:10:00,B,2,0,0',
    't1,08:20:00,08:20:00,C,3,0,0',
    't2,09:00:00,09:00:00,A,1,0,0',
    't2,09:10:00,09:10:00,B,2,0,0',
    't2,09:20:00,09:20:00,C,3,0,0',
    'late,24:30:00,24:30:00,A,1,0,0',
    'late,24:40:00,24:40:00,B,2,0,0',
    'late,24:50:00,24:50:00,C,3,0,0',
    't3,08:30:00,08:30:00,C2,1,0,0',
    't3,08:40:00,08:40:00,D,2,0,0',
    'star1,08:00:00,08:00:00,A,1,0,0',
    'star1,08:10:00,08:10:00,B,2,0,0',
  ].join('\n'),
  'shapes.txt': [
    'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence',
    's1,42.700,-73.700,1',
    's1,42.705,-73.700,2',
    's1,42.710,-73.700,3',
    's1,42.715,-73.700,4',
    's1,42.720,-73.700,5',
    's2,42.7205,-73.7005,1',
    's2,42.730,-73.700,2',
  ].join('\n'),
  'calendar.txt': [
    'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date',
    'WK,1,1,1,1,1,0,0,20261001,20261130',
  ].join('\n'),
  'calendar_dates.txt': ['service_id,date,exception_type', 'WK,20261111,2'].join('\n'),
  'feed_info.txt': ['feed_publisher_name,feed_start_date,feed_end_date,feed_version', 'CDTA,20261001,20261130,Test'].join('\n'),
};

const feed = buildFeed(FILES);
const planner = buildPlanner(feed);
const WEDNESDAY = '2026-11-04';
const walk = (stopId: string, minutes = 2, meters = 150) => ({ stopId, minutes, meters });
const here = { lat: 42.7, lng: -73.7, name: 'Here' };
const there = { lat: 42.73, lng: -73.7, name: 'There' };
const ridesOf = (t: { legs: { kind: string }[] }) => t.legs.filter((l) => l.kind === 'ride') as unknown as { routeShort: string; departMin: number; arriveMin: number; later: number[]; board: { id: string }; alight: { id: string }; path: number[][]; stopsPassed: { name: string }[] }[];

describe('GTFS parsing', () => {
  it('reads quoted fields, colors, and leaves out route 93', () => {
    expect(feed.routes.get('1').long).toBe('Main St, Downtown');
    expect(feed.routes.get('2').color).toBe('#fabe04');
    expect(feed.routes.get('2').textColor).toBe('#000000');
    expect(feed.routes.has('93')).toBe(false);
    expect(feed.tripIndex.has('star1')).toBe(false);
  });

  it('reads times past midnight', () => {
    expect(parseGtfsTime('25:10:00')).toBe(25 * 3600 + 600);
    expect(parseGtfsTime('')).toBe(-1);
  });

  it('applies the calendar, weekends and exceptions', () => {
    expect(feed.activeServices(WEDNESDAY).has('WK')).toBe(true);
    expect(feed.activeServices('2026-11-07').has('WK')).toBe(false); // Saturday
    expect(feed.activeServices('2026-11-11').has('WK')).toBe(false); // Veterans Day exception
    expect(feed.activeServices('2026-12-02').has('WK')).toBe(false); // After the feed ends
    expect(feed.feedEnd).toBe('2026-11-30');
  });

  it('handles stop_times that are out of order', () => {
    const shuffled = { ...FILES, 'stop_times.txt': FILES['stop_times.txt'].split('\n').map((l, i, all) => (i === 0 ? l : all[all.length - i])).join('\n') };
    const f = buildFeed(shuffled);
    const t = f.tripIndex.get('t1');
    const ids = Array.from(f.stStop.subarray(f.stStart[t], f.stStart[t + 1]), (i) => f.stops[i as number].id);
    expect(ids).toEqual(['A', 'B', 'C']);
  });

  it('slices a shape between stops and simplifies straight lines', () => {
    const line = shapeBetween(feed, feed.tripIndex.get('t1'), 1, 2);
    expect(line[0]).toEqual([-73.7, 42.71]);
    expect(line.at(-1)).toEqual([-73.7, 42.72]);
    expect(simplifyLine([[0, 0], [1, 0.0000001], [2, 0]], 0.001)).toEqual([[0, 0], [2, 0]]);
  });

  it('reads a real zip file', () => {
    const zip = zipSync(Object.fromEntries(Object.entries(FILES).map(([k, v]) => [k, strToU8(v)])));
    expect(parseFeedZip(zip).trips.length).toBe(feed.trips.length);
  });
});

describe('transit planner', () => {
  const plan = (startMin: number, access = [walk('A')], egress = [walk('C')], today = WEDNESDAY) =>
    planner.plan({ from: here, to: there, startMin, access, egress, today });

  it('takes the next bus that can be reached on foot', () => {
    const [trip] = plan(7 * 60 + 50);
    const [ride] = ridesOf(trip);
    expect(ride.routeShort).toBe('1');
    expect(ride.departMin).toBe(8 * 60);
    expect(ride.arriveMin).toBe(8 * 60 + 20);
    expect(ride.stopsPassed.map((s) => s.name)).toEqual(['Stop B']);
    expect(ride.path.length).toBeGreaterThan(2);
    expect(trip.leaveMin).toBe(8 * 60 - 1 - 2);
    expect(trip.arriveMin).toBe(8 * 60 + 20 + 2);
  });

  it('misses a bus it cannot walk to in time', () => {
    const [trip] = plan(7 * 60 + 59);
    expect(ridesOf(trip)[0].departMin).toBe(9 * 60);
  });

  it('lists later departures', () => {
    const [trip] = plan(7 * 60 + 50);
    expect(ridesOf(trip)[0].later).toEqual([9 * 60]);
  });

  it('changes buses, walking across the road between stops', () => {
    const [trip] = plan(7 * 60 + 50, [walk('A')], [walk('D')]);
    const rides = ridesOf(trip);
    expect(rides.map((r) => r.routeShort)).toEqual(['1', '2']);
    expect(rides[1].departMin).toBe(8 * 60 + 30);
    expect(trip.hasTransfer).toBe(true);
    const between = trip.legs[2] as unknown as { kind: string; meters: number };
    expect(between.kind).toBe('walk');
    expect(between.meters).toBeGreaterThan(0);
    expect(between.meters).toBeLessThan(220);
  });

  it('leaves time for a connection, in case the first bus runs late', () => {
    // Route 1 reaches C at 8:20 and the walk across is about a minute, so the 8:30 is fine...
    expect(ridesOf(plan(7 * 60 + 50, [walk('A')], [walk('D')])[0])[1].departMin).toBe(8 * 60 + 30);
    // ...but not if it leaves right as you get there.
    const tight = { ...FILES, 'stop_times.txt': FILES['stop_times.txt'].replace('t3,08:30:00,08:30:00,C2', 't3,08:22:00,08:22:00,C2').replace('t3,08:40:00,08:40:00,D', 't3,08:32:00,08:32:00,D') };
    const trips = buildPlanner(buildFeed(tight)).plan({ from: here, to: there, startMin: 7 * 60 + 50, access: [walk('A')], egress: [walk('D')], today: WEDNESDAY });
    expect(ridesOf(trips[0]).at(-1)!.departMin).toBe(24 * 60 + 8 * 60 + 22); // Tomorrow's
  });

  it('walks straight to the destination from the stop the bus reaches, never walk after walk', () => {
    const trips = plan(7 * 60 + 50, [walk('A')], [walk('C2', 1, 80), walk('C', 5, 400)]);
    expect(trips.length).toBeGreaterThan(0);
    for (const trip of trips) {
      trip.legs.forEach((leg: { kind: string }, i: number) => {
        if (i > 0) expect(leg.kind === 'walk' && trip.legs[i - 1].kind === 'walk').toBe(false);
      });
      expect(ridesOf(trip).at(-1)!.alight.id).toBe('C');
    }
  });

  it('only reaches the connection if there is time for it', () => {
    // The 9:00 from A reaches C at 9:20, after today's only route 2 trip has gone, so
    // the best connection is tomorrow morning's.
    const [trip] = plan(8 * 60 + 30, [walk('A')], [walk('D')]);
    expect(ridesOf(trip).at(-1)!.departMin).toBe(24 * 60 + 8 * 60 + 30);
  });

  it('counts a trip after midnight as part of the day before', () => {
    const [trip] = plan(24 * 60 + 10);
    expect(ridesOf(trip)[0].departMin).toBe(24 * 60 + 30);
  });

  it('finds it from just after midnight on the next calendar day', () => {
    const [trip] = plan(10, [walk('A')], [walk('C')], '2026-11-05');
    expect(ridesOf(trip)[0].departMin).toBe(30);
  });

  it('skips days with no service and looks ahead', () => {
    // Friday night: nothing runs Saturday or Sunday, and that's beyond the search horizon.
    expect(plan(10 * 60, [walk('A')], [walk('C')], '2026-11-07')).toEqual([]);
  });

  it('honors no-pickup and no-dropoff stops', () => {
    const files = {
      ...FILES,
      'stop_times.txt': [
        'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type',
        't1,08:00:00,08:00:00,A,1,1,0',
        't1,08:10:00,08:10:00,B,2,0,1',
        't1,08:20:00,08:20:00,C,3,0,0',
      ].join('\n'),
    };
    const p = buildPlanner(buildFeed(files));
    const go = (a: string, b: string) => p.plan({ from: here, to: there, startMin: 7 * 60, access: [walk(a)], egress: [walk(b)], today: WEDNESDAY });
    expect(go('A', 'C')).toEqual([]);
    expect(go('B', 'C').length).toBe(1);
    expect(go('A', 'B')).toEqual([]);
  });

  it('offers a shorter-walk option alongside a faster one', () => {
    // A is a long walk with an earlier bus; B is close and later. Both are worth seeing.
    const trips = plan(7 * 60 + 40, [walk('A', 10, 700), walk('B', 1, 80)], [walk('C')]);
    const boards = trips.map((t) => ridesOf(t)[0].board.id);
    expect(boards).toContain('B');
  });

  it('ignores unknown stops and returns nothing when no stops are given', () => {
    expect(plan(8 * 60, [], [walk('C')])).toEqual([]);
    expect(plan(8 * 60, [walk('NOPE')], [walk('C')])).toEqual([]);
  });

  it('never returns a trip that uses only shuttles', () => {
    const mixed = buildPlanner(feed, { routes, schedule });
    const trips = mixed.plan({
      from: here,
      to: there,
      startMin: 12 * 60,
      access: [walk('rpi:WEST:ACADEMY_HALL')],
      egress: [walk('rpi:WEST:BLITMAN')],
      today: WEDNESDAY,
    });
    expect(trips).toEqual([]);
  });

  it('connects a shuttle to a CDTA bus', () => {
    // Move stop A beside a shuttle stop, so a West shuttle can feed route 1's next run.
    const near = { ...FILES };
    near['stops.txt'] = FILES['stops.txt'].replace('A,A,Stop A,42.700,-73.700', 'A,A,Stop A,42.727673,-73.687228');
    const mixed = buildPlanner(buildFeed(near), { routes, schedule });
    const trips = mixed.plan({
      from: here,
      to: there,
      startMin: 8 * 60 + 40,
      access: [walk('rpi:WEST:ACADEMY_HALL')],
      egress: [walk('C')],
      today: WEDNESDAY,
    });
    expect(trips.length).toBeGreaterThan(0);
    const rides = ridesOf(trips[0]);
    expect(rides[0].routeShort).toBe('West');
    expect(rides[1].routeShort).toBe('1');
    expect(rides[1].departMin).toBeGreaterThanOrEqual(rides[0].arriveMin);
    expect(rides[0].path.length).toBeGreaterThan(5);
  });

  it('parses shuttle times the same way as the browser', () => {
    expect(parseShuttleTime('12:00 AM')).toBe(86_400);
    expect(parseShuttleTime('7:25 PM')).toBe(19 * 3600 + 25 * 60);
    expect(parseShuttleTime('nonsense')).toBeNull();
  });
});

describe('live data', () => {
  const NOW = { today: WEDNESDAY, minutes: 8 * 60 + 5, epoch: 1_800_000_000 };
  const inMinutes = (m: number) => NOW.epoch + m * 60;
  const vehicle = (over: object) => ({
    vehicle: {
      vehicle: { id: '100' },
      trip: { tripId: 't1', routeId: '1' },
      position: { latitude: 42.71, longitude: -73.7 },
      timestamp: NOW.epoch - 20,
      currentStopSequence: 2,
      currentStatus: 'IN_TRANSIT_TO',
      occupancyStatus: 'FEW_SEATS_AVAILABLE',
      ...over,
    },
  });

  it('keeps passenger buses and drops STAR, maintenance, silent and position-less ones', () => {
    const list = listVehicles(feed, {
      entity: [
        vehicle({}),
        vehicle({ vehicle: { id: 'star' }, trip: { tripId: 'x-OCT26-Star-Sunday-01', routeId: '93' } }),
        vehicle({ vehicle: { id: 'maint' }, trip: { tripId: 'x-OCT26-MAINTEN-Sunday-01', routeId: '1' } }),
        vehicle({ vehicle: { id: 'old' }, timestamp: NOW.epoch - 3600 }),
        vehicle({ vehicle: { id: 'nots' }, timestamp: 0 }),
        vehicle({ vehicle: { id: 'nopos' }, position: undefined }),
      ],
    }, NOW.epoch);
    expect(list.map((v: { id: string }) => v.id)).toEqual(['100']);
    expect(list[0].short).toBe('1');
    expect(list[0].headsign).toBe('To C');
    expect(list[0].occupancy).toBe('Few seats left');
  });

  const updates = indexTripUpdates({
    entity: [{
      tripUpdate: {
        trip: { tripId: 't1', startDate: '20261104' },
        vehicle: { id: '100' },
        stopTimeUpdate: [
          { stopSequence: 2, stopId: 'B', arrival: { time: inMinutes(9) } },
          { stopSequence: 3, stopId: 'C', departure: { time: inMinutes(19) } },
        ],
      },
    }],
  });

  it('merges predictions into stop arrivals, in predicted order', () => {
    const [first, second] = stopArrivals(feed, feed.stopIndex.get('B'), NOW, updates);
    expect(first.tripId).toBe('t1');
    expect(first.schedMin).toBe(8 * 60 + 10);
    expect(first.liveMin).toBeCloseTo(8 * 60 + 14);
    expect(first.vehicleId).toBe('100');
    expect(second.tripId).toBe('t2');
    expect(second.liveMin).toBeNull();
  });

  it('ignores a prediction for a different day', () => {
    const other = indexTripUpdates({ entity: [{ tripUpdate: { trip: { tripId: 't1', startDate: '20261103' }, stopTimeUpdate: [{ stopSequence: 2, stopId: 'B', arrival: { time: inMinutes(9) } }] } }] });
    expect(stopArrivals(feed, feed.stopIndex.get('B'), NOW, other)[0].liveMin).toBeNull();
  });

  it("doesn't list a bus at its last stop, where it lets people off", () => {
    expect(stopArrivals(feed, feed.stopIndex.get('C'), NOW, new Map())).toEqual([]);
  });

  it('looks ahead to the next service when nothing is due soon', () => {
    const friday = { today: '2026-11-06', minutes: 23 * 60, epoch: NOW.epoch };
    const found = stopArrivals(feed, feed.stopIndex.get('A'), friday, new Map());
    expect(found.length).toBeGreaterThan(0);
    expect(found[0].schedMin).toBe(24 * 60 + 30); // Friday's after-midnight trip
  });

  it('describes a bus with its next stops and how late it is', () => {
    const [v] = listVehicles(feed, { entity: [vehicle({})] }, NOW.epoch);
    const detail = vehicleDetail(feed, v, updates, NOW);
    expect(detail.currentStopName).toBe('Stop B');
    expect(detail.upcoming.map((u: { name: string }) => u.name)).toEqual(['Stop B', 'Stop C']);
    expect(detail.delayMin).toBeCloseTo(4);
  });

  it('skips the stop a bus is sitting at', () => {
    const [v] = listVehicles(feed, { entity: [vehicle({ currentStatus: 'STOPPED_AT' })] }, NOW.epoch);
    expect(vehicleDetail(feed, v, updates, NOW).upcoming.map((u: { name: string }) => u.name)).toEqual(['Stop C']);
  });

  it('separates the run-together labels in alert text', () => {
    const [alert] = listAlerts({
      entity: [{
        id: '1',
        alert: {
          headerText: { translation: [{ text: '114 Detour' }] },
          descriptionText: { translation: [{ text: 'Route: 114Direction: WestboundReason: ConstructionBus Stop Closed: none' }] },
          url: { translation: [{ text: 'https://www.cdta.org/node/1' }] },
          informedEntity: [{ routeId: '114', stopId: '99' }],
        },
      }],
    });
    expect(alert.description).toBe('Route: 114\nDirection: Westbound\nReason: Construction\nBus Stop Closed: none');
    expect(alert.routes).toEqual(['114']);
    expect(alert.stops).toEqual(['99']);
  });

  it('builds a route with its stops in order', () => {
    const detail = routeDetail(feed, '1', NOW);
    expect(detail!.directions.length).toBe(1);
    const [direction] = detail!.directions;
    expect(direction.stops.map((s: { name: string }) => s.name)).toEqual(['Stop A', 'Stop B', 'Stop C']);
    expect(direction.tripsToday).toBe(3);
    expect(direction.firstMin).toBe(8 * 60);
    expect(routeDetail(feed, '93', NOW)).toBeNull();
  });

  it('gives an overview with no STAR route, and stops listing their routes', () => {
    const overview = buildOverview(feed);
    expect(overview.routes.map((r: { id: string }) => r.id)).toEqual(['1', '2']);
    expect(overview.stops.find((s: { id: string }) => s.id === 'B').routes).toEqual(['1']);
    expect(overview.lines.length).toBe(2);
    expect(overview.feed.end).toBe('2026-11-30');
  });

  it('reads the date and time in Troy', () => {
    const t = troyNow(new Date('2026-11-05T02:30:00Z'));
    expect(t.today).toBe('2026-11-04');
    expect(t.minutes).toBe(21 * 60 + 30);
  });
});

describe('the compact file the browser loads', () => {
  const overview = buildOverview(feed);
  const rebuilt = feedFromCompact(overview, JSON.parse(JSON.stringify(compactFeed(feed, overview.stops))));
  const NOW = { today: WEDNESDAY, minutes: 7 * 60 + 50, epoch: 1_800_000_000 };

  it('keeps every trip, with its id, route and times', () => {
    expect(rebuilt.trips.map((t: { id: string }) => t.id).sort()).toEqual(feed.trips.map((t: { id: string }) => t.id).sort());
    const check = (id: string) => {
      const a = feed.tripIndex.get(id);
      const b = rebuilt.tripIndex.get(id);
      const stopsOf = (f: typeof feed, t: number) => Array.from(f.stStop.subarray(f.stStart[t], f.stStart[t + 1]), (i) => f.stops[i as number].id);
      expect(stopsOf(rebuilt, b)).toEqual(stopsOf(feed, a));
      expect(Array.from(rebuilt.stDep.subarray(rebuilt.stStart[b], rebuilt.stStart[b + 1]))).toEqual(Array.from(feed.stDep.subarray(feed.stStart[a], feed.stStart[a + 1])));
      expect(rebuilt.trips[b].headsign).toBe(feed.trips[a].headsign);
    };
    ['t1', 't2', 'late', 't3'].forEach(check);
  });

  it('keeps the calendar, including exceptions', () => {
    expect(rebuilt.activeServices(WEDNESDAY).has('WK')).toBe(true);
    expect(rebuilt.activeServices('2026-11-11').has('WK')).toBe(false);
    expect(rebuilt.activeServices('2026-11-07').has('WK')).toBe(false);
  });

  it('answers questions the same as the original', () => {
    const arrivals = (f: typeof feed) => stopArrivals(f, f.stopIndex.get('B'), NOW, new Map()).map((a: { tripId: string; schedMin: number }) => [a.tripId, a.schedMin]);
    expect(arrivals(rebuilt)).toEqual(arrivals(feed));
    const trip = (f: typeof feed) => buildPlanner(f).plan({ from: here, to: there, startMin: NOW.minutes, access: [walk('A')], egress: [walk('D')], today: WEDNESDAY });
    const [a] = trip(feed);
    const [b] = trip(rebuilt);
    expect(b.id).toBe(a.id);
    expect(b.arriveMin).toBe(a.arriveMin);
    expect(ridesOf(b)[0].path.length).toBeGreaterThan(1);
  });
});

describe('decoding live feeds', () => {
  const { FeedMessage } = GtfsRealtime.transit_realtime;
  const official = (bytes: Uint8Array) => FeedMessage.toObject(FeedMessage.decode(bytes), { longs: Number, enums: String }) as { header: { timestamp: number }; entity: any[] };
  const read = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}.pb`, import.meta.url)));

  it('reads real vehicle positions exactly as the official library does', () => {
    const bytes = read('VehiclePositions');
    const mine = decodeFeedMessage(bytes);
    const theirs = official(bytes);
    expect((mine.header as { timestamp: number }).timestamp).toBe(theirs.header.timestamp);
    expect(mine.entity.length).toBe(theirs.entity.length);
    mine.entity.forEach((e: any, i: number) => {
      const t = theirs.entity[i].vehicle;
      expect(e.vehicle.vehicle.id).toBe(t.vehicle.id);
      expect(e.vehicle.trip.tripId).toBe(t.trip.tripId);
      expect(e.vehicle.trip.routeId).toBe(t.trip.routeId);
      expect(e.vehicle.position.latitude).toBeCloseTo(t.position.latitude, 5);
      expect(e.vehicle.position.longitude).toBeCloseTo(t.position.longitude, 5);
      expect(e.vehicle.timestamp ?? 0).toBe(t.timestamp ?? 0);
      expect(e.vehicle.currentStopSequence).toBe(t.currentStopSequence);
      expect(e.vehicle.currentStatus).toBe(t.currentStatus);
      expect(e.vehicle.occupancyStatus).toBe(t.occupancyStatus);
    });
  });

  it('reads real trip updates exactly as the official library does', () => {
    const bytes = read('TripUpdates');
    const mine = decodeFeedMessage(bytes);
    const theirs = official(bytes);
    expect(mine.entity.length).toBe(theirs.entity.length);
    mine.entity.forEach((e: any, i: number) => {
      const t = theirs.entity[i].tripUpdate;
      expect(e.tripUpdate.trip.tripId).toBe(t.trip.tripId);
      expect(e.tripUpdate.trip.startDate).toBe(t.trip.startDate);
      expect(e.tripUpdate.vehicle?.id).toBe(t.vehicle?.id);
      expect(e.tripUpdate.stopTimeUpdate.length).toBe(t.stopTimeUpdate.length);
      e.tripUpdate.stopTimeUpdate.forEach((s: any, j: number) => {
        const u = t.stopTimeUpdate[j];
        expect(s.stopId).toBe(u.stopId);
        expect(s.stopSequence).toBe(u.stopSequence);
        expect(s.arrival?.time).toBe(u.arrival?.time);
        expect(s.departure?.time).toBe(u.departure?.time);
      });
    });
    expect(indexTripUpdates(mine).size).toBe(indexTripUpdates(theirs).size);
  });

  it('reads real alerts exactly as the official library does', () => {
    const bytes = read('ServiceAlerts');
    const mine = listAlerts(decodeFeedMessage(bytes));
    expect(mine).toEqual(listAlerts(official(bytes)));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine[0].header).toBeTruthy();
  });

  it('copes with an empty feed', () => {
    expect(decodeFeedMessage(new Uint8Array()).entity).toEqual([]);
  });
});

describe('every bus that can get you there', () => {
  // Route 1 is quick and route 2 is slow, but both run from Stop A to near the destination.
  const files = {
    ...FILES,
    'trips.txt': `${FILES['trips.txt']}\n2,WK,slow,To C,0,s1`,
    'stop_times.txt': `${FILES['stop_times.txt']}\nslow,09:30:00,09:30:00,A,1,0,0\nslow,10:10:00,10:10:00,C2,2,0,0`,
  };
  const p = buildPlanner(buildFeed(files));
  const go = (access: object[], egress: object[]) => p.plan({ from: here, to: there, startMin: 7 * 60 + 50, access, egress, today: WEDNESDAY });
  const lastRoutes = (trips: Parameters<typeof ridesOf>[0][]) => new Set(trips.map((t) => ridesOf(t).at(-1)!.routeShort));

  it('offers a route even when another gets there first', () => {
    const trips = go([walk('A')], [walk('C'), walk('C2')]);
    expect(lastRoutes(trips)).toEqual(new Set(['1', '2']));
    const slow = trips.find((t: Parameters<typeof ridesOf>[0]) => ridesOf(t).at(-1)!.routeShort === '2');
    expect(ridesOf(slow)[0].board.id).toBe('A');
    expect(ridesOf(slow)[0].alight.id).toBe('C2');
  });

  it('still finds the connection when a much later bus also reaches the same stop', () => {
    // The slow bus reaches C2 at 10:10, but walking across from route 1 gets there at about 8:21.
    const [fastest] = go([walk('A')], [walk('D')]);
    expect(ridesOf(fastest).map((r) => r.departMin)).toEqual([8 * 60, 8 * 60 + 30]);
  });

  it('includes a route that needs a change to reach', () => {
    const trips = go([walk('A')], [walk('D')]);
    const rides = ridesOf(trips.find((t: Parameters<typeof ridesOf>[0]) => ridesOf(t).at(-1)!.routeShort === '2'));
    expect(rides.map((r) => r.routeShort)).toEqual(['1', '2']);
  });

  it('leaves out routes that only stop far from the destination', () => {
    const trips = go([walk('A')], [walk('C'), walk('C2', 30, 2000)]);
    const viaSlow = trips.filter((t: Parameters<typeof ridesOf>[0]) => ridesOf(t).at(-1)!.alight.id === 'C2');
    expect(viaSlow).toEqual([]);
  });

  it('boards at the closest stop that can still catch the bus', () => {
    const trips = go([walk('A', 20, 1500), walk('B', 2, 150)], [walk('C')]);
    expect(ridesOf(trips.find((t: Parameters<typeof ridesOf>[0]) => ridesOf(t).at(-1)!.routeShort === '1'))[0].board.id).toBe('B');
  });
});

describe('merging trips', () => {
  const rideOn = (routeId: string) => ({ kind: 'ride', routeId }) as never;
  const trip = (over: Partial<Trip> & { route?: string }): Trip => {
    const { route = 'A', ...rest } = over;
    return { id: route, kind: 'transit', legs: [rideOn(route)], leaveMin: 0, arriveMin: 30, walkMinutes: 5, walkMeters: 400, hasTransfer: false, hasEstimatedWalk: false, ...rest };
  };
  const walkTrip = (over: Partial<Trip> = {}) => trip({ id: 'walk', kind: 'walk', legs: [], arriveMin: 100, walkMinutes: 100, walkMeters: 8000, ...over });

  it('shows one option per route, best first, including slower routes', () => {
    const merged = mergeTrips([walkTrip()], [trip({ route: 'SLOW', arriveMin: 60 }), trip({ route: 'FAST' })]).map((t) => t.id);
    expect(merged).toEqual(['FAST', 'SLOW', 'walk']);
  });

  it('keeps the better of two trips ending on the same route', () => {
    const merged = mergeTrips([], [trip({ id: 'worse', route: 'A', arriveMin: 50 }), trip({ id: 'better', route: 'A', arriveMin: 30 })]);
    expect(merged.map((t) => t.id)).toEqual(['better']);
  });

  it('treats a shuttle the same from either planner', () => {
    const merged = mergeTrips([trip({ id: 'one', route: 'WEST' })], [trip({ id: 'two', route: 'rpi:WEST', arriveMin: 40 })]);
    expect(merged.map((t) => t.id)).toEqual(['one']);
  });

  it('ranks an extra change below a trip that is only a little slower', () => {
    const merged = mergeTrips([], [
      trip({ id: 'three-buses', legs: [rideOn('X'), rideOn('Y'), rideOn('Z')], arriveMin: 52, walkMeters: 300, hasTransfer: true }),
      trip({ id: 'two-buses', legs: [rideOn('X'), rideOn('W')], arriveMin: 54, walkMeters: 400, hasTransfer: true }),
    ]).map((t) => t.id);
    expect(merged).toEqual(['two-buses', 'three-buses']);
  });

  it('ranks a bus ahead of a long walk that only arrives a little sooner', () => {
    const merged = mergeTrips([walkTrip({ arriveMin: 38, walkMinutes: 18, walkMeters: 1600 })], [trip({ id: 'bus', route: 'WEST', arriveMin: 44, walkMinutes: 3, walkMeters: 200 })]);
    expect(merged.map((t) => t.id)).toEqual(['bus', 'walk']);
  });

  it('still ranks a short walk first when the bus is a long wait away', () => {
    const merged = mergeTrips([walkTrip({ arriveMin: 7, walkMinutes: 7, walkMeters: 500 })], [trip({ id: 'bus', route: 'WEST', arriveMin: 25, walkMinutes: 3, walkMeters: 200 })]);
    expect(merged.map((t) => t.id)).toEqual(['walk', 'bus']);
  });

  it('drops a bus much later than the quickest, and one with as much walking as walking there', () => {
    const merged = mergeTrips([walkTrip({ walkMeters: 500 })], [
      trip({ id: 'soon', route: 'A' }),
      trip({ id: 'hours-later', route: 'B', arriveMin: 200 }),
      trip({ id: 'pointless', route: 'C', walkMeters: 500 }),
    ]).map((t) => t.id);
    expect(merged).toEqual(['soon', 'walk']);
  });

  it('caps a long list, and copes with nothing but walking, or nothing at all', () => {
    const many = Array.from({ length: 12 }, (_, i) => trip({ id: `r${i}`, route: `r${i}`, arriveMin: 30 + i }));
    expect(mergeTrips([], many).length).toBe(8);
    expect(mergeTrips([walkTrip()], []).length).toBe(1);
    expect(mergeTrips([], [])).toEqual([]);
  });
});

it('fixtures are the real shuttle data', () => {
  expect(JSON.parse(readFileSync(new URL('./fixtures/routes.json', import.meta.url), 'utf8')).WEST).toBeDefined();
});
