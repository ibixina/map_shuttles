// Answers the app's questions about CDTA: pure functions over the feed tables and
// decoded live feeds, used by the browser's engine worker and at build time.
import { addDays, FLAG_NO_PICKUP, isPassengerTrip, shapeCoords, simplifyLine } from './gtfs.mjs';

const MAX_VEHICLE_AGE_S = 600;
const ARRIVAL_WINDOW_MIN = 180;
const MAX_ARRIVALS = 14;

const OCCUPANCY = {
  EMPTY: 'Empty',
  MANY_SEATS_AVAILABLE: 'Plenty of seats',
  FEW_SEATS_AVAILABLE: 'Few seats left',
  STANDING_ROOM_ONLY: 'Standing room only',
  CRUSHED_STANDING_ROOM_ONLY: 'Very crowded',
  FULL: 'Full',
  NOT_ACCEPTING_PASSENGERS: 'Not taking passengers',
};

/** Troy's date, and absolute minutes from its midnight (the app's shared time scale). */
export function troyNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    today: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')) + Number(get('second')) / 60,
    epoch: date.getTime() / 1000,
  };
}

// --- Questions the app asks ----------------------------------------------------------

/** Routes, stops and one line per direction, for drawing the system and searching it. */
export function buildOverview(feed) {
  const routesAtStop = feed.stops.map(() => new Set());
  const shapeUse = new Map();
  feed.trips.forEach((trip, t) => {
    for (let i = feed.stStart[t]; i < feed.stStart[t + 1]; i++) routesAtStop[feed.stStop[i]].add(trip.routeId);
    const key = `${trip.routeId}|${trip.direction}|${trip.shapeId}`;
    shapeUse.set(key, (shapeUse.get(key) ?? 0) + 1);
  });
  const bestShape = new Map();
  for (const [key, uses] of shapeUse) {
    const [routeId, direction, shapeId] = key.split('|');
    const group = `${routeId}|${direction}`;
    if (!bestShape.has(group) || uses > bestShape.get(group).uses) bestShape.set(group, { routeId, shapeId, uses });
  }
  const round = (n) => Math.round(n * 1e5) / 1e5;
  const lines = [...bestShape.values()].map(({ routeId, shapeId }) => ({
    routeId,
    coords: simplifyLine(shapeCoords(feed, shapeId), 0.00012).map(([x, y]) => [round(x), round(y)]),
  }));
  return {
    feed: { end: feed.feedEnd, version: feed.feedVersion },
    routes: feed.routeList.map(({ id, short, long, desc, color, textColor, sort }) => ({ id, short, long, desc, color, textColor, sort })),
    stops: feed.stops.flatMap((s, i) =>
      routesAtStop[i].size ? [{ id: s.id, code: s.code, name: s.name, lat: s.lat, lng: s.lng, routes: [...routesAtStop[i]] }] : [],
    ),
    lines,
  };
}

function routeRef(feed, routeId) {
  const r = feed.routes.get(routeId);
  return r ? { routeId, short: r.short, long: r.long, color: r.color, textColor: r.textColor } : { routeId, short: routeId, long: '', color: '#5f6672', textColor: '#ffffff' };
}

/** tripId -> { startDate, vehicleId, times: stop id or sequence -> epoch seconds }. */
export function indexTripUpdates(message) {
  const byTrip = new Map();
  for (const entity of message?.entity ?? []) {
    const update = entity.tripUpdate;
    if (!update?.trip?.tripId) continue;
    const bySequence = new Map();
    const byStop = new Map();
    for (const s of update.stopTimeUpdate ?? []) {
      const at = s.departure?.time || s.arrival?.time;
      if (!at || s.scheduleRelationship === 'SKIPPED') continue;
      if (s.stopSequence != null) bySequence.set(s.stopSequence, at);
      if (s.stopId) byStop.set(s.stopId, at);
    }
    byTrip.set(update.trip.tripId, { startDate: update.trip.startDate, vehicleId: update.vehicle?.id, bySequence, byStop });
  }
  return byTrip;
}

const compactDate = (dateKey) => dateKey.replaceAll('-', '');

export function predicted(update, serviceDate, sequence, stopId) {
  if (!update || (update.startDate && update.startDate !== compactDate(serviceDate))) return null;
  return update.bySequence.get(sequence) ?? update.byStop.get(stopId) ?? null;
}

/** Upcoming departures at a stop, soonest first, using live predictions where they exist. */
export function stopArrivals(feed, stopIndex, now, updates, { limit = MAX_ARRIVALS } = {}) {
  const stop = feed.stops[stopIndex];
  const rows = feed.rowsAtStop[stopIndex] ?? [];
  const collect = (fromDay, toDay, windowEnd) => {
    const out = [];
    for (let day = fromDay; day <= toDay; day++) {
      const serviceDate = addDays(now.today, day);
      const active = feed.activeServices(serviceDate);
      for (const row of rows) {
        const t = feed.tripOfRow[row];
        const trip = feed.trips[t];
        if (!active.has(trip.serviceId)) continue;
        if (feed.stFlags[row] & FLAG_NO_PICKUP) continue;
        if (row === feed.stStart[t + 1] - 1) continue; // The bus ends here.
        const schedMin = feed.stDep[row] / 60 + day * 1440;
        const update = updates.get(trip.id);
        const at = predicted(update, serviceDate, feed.stSeq[row], stop.id);
        const liveMin = at ? now.minutes + (at - now.epoch) / 60 : null;
        const effective = liveMin ?? schedMin;
        if (effective < now.minutes - 1 || effective > windowEnd) continue;
        out.push({ ...routeRef(feed, trip.routeId), tripId: trip.id, headsign: trip.headsign, schedMin, liveMin, vehicleId: at ? update.vehicleId ?? null : null });
      }
    }
    return out.sort((a, b) => (a.liveMin ?? a.schedMin) - (b.liveMin ?? b.schedMin));
  };
  const soon = collect(-1, 1, now.minutes + ARRIVAL_WINDOW_MIN);
  if (soon.length) return soon.slice(0, limit);
  // Nothing soon: look ahead to the next service, so the panel still says something useful.
  return collect(-1, 4, Infinity).slice(0, Math.min(limit, 4));
}

export function routeDetail(feed, routeId, now) {
  const route = feed.routes.get(routeId);
  if (!route) return null;
  const active = feed.activeServices(now.today);
  const groups = new Map();
  feed.trips.forEach((trip, t) => {
    if (trip.routeId !== routeId) return;
    const start = feed.stStart[t];
    const stopIds = Array.from(feed.stStop.subarray(start, feed.stStart[t + 1]));
    const key = `${trip.direction}|${trip.shapeId}|${stopIds.join(',')}`;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { direction: trip.direction, shapeId: trip.shapeId, stopIds, headsign: trip.headsign, uses: 0, today: 0, first: Infinity, last: -Infinity }));
    group.uses++;
    if (active.has(trip.serviceId)) {
      group.today++;
      group.first = Math.min(group.first, feed.stDep[start] / 60);
      group.last = Math.max(group.last, feed.stDep[start] / 60);
    }
  });
  const directions = [];
  for (const direction of [0, 1]) {
    const list = [...groups.values()].filter((g) => g.direction === direction);
    if (!list.length) continue;
    // Today's most-run version of this direction, or the most-run overall if none today.
    list.sort((a, b) => b.today - a.today || b.uses - a.uses);
    const main = list[0];
    const hours = list.filter((g) => g.today > 0);
    directions.push({
      direction,
      headsign: main.headsign,
      stops: main.stopIds.map((i) => {
        const s = feed.stops[i];
        return { id: s.id, name: s.name, lat: s.lat, lng: s.lng };
      }),
      path: simplifyLine(shapeCoords(feed, main.shapeId), 0.00004),
      firstMin: hours.length ? Math.min(...hours.map((g) => g.first)) : null,
      lastMin: hours.length ? Math.max(...hours.map((g) => g.last)) : null,
      tripsToday: list.reduce((sum, g) => sum + g.today, 0),
    });
  }
  return { ...routeRef(feed, routeId), desc: route.desc, directions };
}

/** Turns a VehiclePositions message into what the map draws, dropping non-passenger buses. */
export function listVehicles(feed, message, nowEpoch) {
  const out = [];
  for (const entity of message?.entity ?? []) {
    const v = entity.vehicle;
    const position = v?.position;
    const id = v?.vehicle?.id ?? entity.id;
    const routeId = v?.trip?.routeId;
    const tripId = v?.trip?.tripId;
    if (!position || !routeId || !v.timestamp) continue;
    if (!isPassengerTrip(routeId, tripId)) continue;
    const ageSeconds = Math.max(0, nowEpoch - v.timestamp);
    if (ageSeconds > MAX_VEHICLE_AGE_S) continue;
    const t = feed.tripIndex.get(tripId);
    const trip = t === undefined ? null : feed.trips[t];
    out.push({
      id,
      ...routeRef(feed, routeId),
      tripId,
      headsign: trip?.headsign ?? '',
      lat: position.latitude,
      lng: position.longitude,
      ageSeconds,
      status: v.currentStatus ?? null,
      stopSequence: v.currentStopSequence ?? null,
      occupancy: OCCUPANCY[v.occupancyStatus] ?? null,
    });
  }
  return out;
}

export function vehicleDetail(feed, vehicle, updates, now) {
  const t = feed.tripIndex.get(vehicle.tripId);
  const upcoming = [];
  let delayMin = null;
  let currentStopName = null;
  if (t !== undefined) {
    const update = updates.get(vehicle.tripId);
    for (let i = feed.stStart[t]; i < feed.stStart[t + 1]; i++) {
      const sequence = feed.stSeq[i];
      const stop = feed.stops[feed.stStop[i]];
      if (vehicle.stopSequence != null && sequence === vehicle.stopSequence) currentStopName = stop.name;
      if (vehicle.stopSequence != null && sequence < vehicle.stopSequence) continue;
      if (vehicle.status === 'STOPPED_AT' && sequence === vehicle.stopSequence) continue;
      const at = update && (update.bySequence.get(sequence) ?? update.byStop.get(stop.id));
      const liveMin = at ? now.minutes + (at - now.epoch) / 60 : null;
      if (liveMin != null && liveMin < now.minutes - 1) continue;
      const schedMin = feed.stDep[i] / 60;
      if (delayMin == null && liveMin != null) delayMin = liveMin - schedMin;
      upcoming.push({ stopId: stop.id, name: stop.name, schedMin, liveMin });
    }
  }
  return { ...vehicle, currentStopName, delayMin, upcoming };
}

const firstText = (translated) => translated?.translation?.[0]?.text ?? '';

/** CDTA's alert text runs its labels together ("Route: 114Direction: West"); split them. */
function tidyAlertText(text) {
  return text.replace(/\s*(Direction|Reason|Reroute|Duration|Bus Stop Closed):/g, '\n$1:').trim();
}

export function listAlerts(message) {
  return (message?.entity ?? []).flatMap((entity) => {
    const alert = entity.alert;
    if (!alert) return [];
    return [{
      id: entity.id,
      header: firstText(alert.headerText),
      description: tidyAlertText(firstText(alert.descriptionText)),
      url: firstText(alert.url),
      routes: (alert.informedEntity ?? []).map((e) => e.routeId).filter(Boolean),
      stops: (alert.informedEntity ?? []).map((e) => e.stopId).filter(Boolean),
    }];
  });
}
