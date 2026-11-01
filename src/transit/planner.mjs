// Trip planning across CDTA and the RPI shuttles, using RAPTOR: each round allows one
// more bus, so the results naturally include the fastest trip for each number of
// changes. Walking at the two ends comes from the browser, which has real walking
// times; walks between stops during a change are estimated here.
import { addDays, FLAG_NO_DROPOFF, FLAG_NO_PICKUP, shapeBetween, weekdayOf } from './gtfs.mjs';

const MAX_BOARDINGS = 3;
const BOARDING_BUFFER_S = 60;
/** A connection depends on the first bus being on time, so it needs more slack. */
const CONNECTION_BUFFER_S = 180;
const TRANSFER_RADIUS_M = 220;
const DETOUR_FACTOR = 1.25;
const WALK_METERS_PER_MIN = 75;
/** Don't suggest waiting longer than this for the first bus. */
const SEARCH_HORIZON_S = 36 * 3600;
const DAY_S = 86_400;
/** Walking limits tried in turn, so an option with less walking isn't lost to one that's a minute faster. */
const WALK_LIMITS_M = [350, 800, Infinity];
const MIN_WALK_LEG_METERS = 20;
/** For "every bus that can get you there": a route counts if it stops this close to the destination. */
const ROUTE_OPTION_WALK_M = 1_200;
const WALK_COST_WEIGHT = 0.5;
const CHANGE_COST_MIN = 4;
const MAX_LATER = 3;

const metersBetween = (a, b) => Math.hypot((a.lng - b.lng) * 81_500, (a.lat - b.lat) * 111_000);

const WEEKDAY_NAMES = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

/** "7:25 PM" to seconds. Times before 4 AM belong to the previous evening's service. */
export function parseShuttleTime(text) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(text).trim());
  if (!m) return null;
  const pm = m[3].toUpperCase() === 'PM';
  const hour = (Number(m[1]) % 12) + (pm ? 12 : 0);
  const seconds = (hour * 60 + Number(m[2])) * 60;
  return !pm && hour < 4 ? seconds + DAY_S : seconds;
}

/** Turns the shuttle API's routes and schedule into the same trip shape as GTFS. */
function shuttleTrips(raw, schedule, addNode) {
  const trips = [];
  const lines = new Map();
  const colors = { NORTH: '#d6322c', WEST: '#1f6feb' };
  for (const [routeId, r] of Object.entries(raw ?? {})) {
    if (typeof r.COLOR !== 'string' || (r.COLOR.length === 9 && r.COLOR.endsWith('00'))) continue;
    const keys = r.STOPS ?? [];
    const nodes = keys.map((key, i) => {
      const s = r[key];
      const isReturn = i === keys.length - 1 && key.endsWith('_RETURN');
      return addNode({
        id: `rpi:${routeId}:${key}`,
        name: s.NAME.replace(/\s*\(Return\)$/, ''),
        lat: s.COORDINATES[0],
        lng: s.COORDINATES[1],
        isReturn,
      });
    });
    const offsets = keys.map((key) => r[key].OFFSET * 60);
    const name = routeId.charAt(0) + routeId.slice(1).toLowerCase();
    const route = {
      agency: 'rpi',
      id: `rpi:${routeId}`,
      short: name,
      name: `${name} Route`,
      color: colors[routeId] ?? r.COLOR,
      textColor: '#ffffff',
    };
    lines.set(route.id, (r.ROUTES ?? []).map((leg) => leg.map(([lat, lng]) => [lng, lat])));
    for (const dayType of new Set(WEEKDAY_NAMES.map((d) => schedule?.[d]))) {
      const seen = new Set();
      for (const runs of Object.values(schedule?.[dayType] ?? {})) {
        for (const [time, runRoute] of runs) {
          const start = parseShuttleTime(time);
          if (runRoute !== routeId || start == null || seen.has(start)) continue;
          seen.add(start);
          const times = Int32Array.from(offsets, (o) => start + o);
          trips.push({
            route,
            serviceId: `rpi:${dayType}`,
            headsign: `${name} loop`,
            id: `rpi:${routeId}:${dayType}:${start}`,
            stops: Int32Array.from(nodes),
            arr: times,
            dep: times,
            flags: null,
            gtfsIndex: -1,
          });
        }
      }
    }
  }
  return { trips, lines };
}

export function buildPlanner(feed, shuttle = {}) {
  const nodes = feed.stops.map((s) => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng }));
  const nodeIndex = new Map(nodes.map((n, i) => [n.id, i]));
  const addNode = (node) => {
    nodeIndex.set(node.id, nodes.length);
    nodes.push(node);
    return nodes.length - 1;
  };

  const { trips: rpiTrips, lines: rpiLines } = shuttleTrips(shuttle.routes, shuttle.schedule, addNode);
  const routeRefs = new Map(
    feed.routeList.map((r) => [r.id, { agency: 'cdta', id: r.id, short: r.short, name: r.long, color: r.color, textColor: r.textColor }]),
  );
  const allTrips = feed.trips.map((t, i) => {
    const a = feed.stStart[i];
    const b = feed.stStart[i + 1];
    return {
      route: routeRefs.get(t.routeId),
      serviceId: t.serviceId,
      headsign: t.headsign,
      id: t.id,
      stops: feed.stStop.subarray(a, b),
      arr: feed.stArr.subarray(a, b),
      dep: feed.stDep.subarray(a, b),
      flags: feed.stFlags.subarray(a, b),
      gtfsIndex: i,
    };
  });
  allTrips.push(...rpiTrips);

  // Patterns: trips that visit exactly the same stops in the same order.
  const patternByKey = new Map();
  for (const trip of allTrips) {
    if (trip.stops.length < 2) continue;
    const key = `${trip.route.id}|${trip.stops.join(',')}`;
    let pattern = patternByKey.get(key);
    if (!pattern) {
      pattern = { stops: trip.stops, trips: [] };
      patternByKey.set(key, pattern);
    }
    pattern.trips.push(trip);
  }
  const patterns = [...patternByKey.values()];
  const patternsAtNode = Array.from({ length: nodes.length }, () => []);
  patterns.forEach((pattern, p) => {
    pattern.index = p;
    pattern.trips.sort((a, b) => a.dep[0] - b.dep[0]);
    pattern.stops.forEach((node, pos) => patternsAtNode[node].push(p, pos));
  });

  // Walks between nearby stops, using a coarse grid so this isn't all-pairs.
  const grid = new Map();
  const cell = (lat, lng) => `${Math.floor(lat / 0.0025)},${Math.floor(lng / 0.0035)}`;
  nodes.forEach((n, i) => {
    const c = cell(n.lat, n.lng);
    if (!grid.has(c)) grid.set(c, []);
    grid.get(c).push(i);
  });
  const footpaths = nodes.map((n, i) => {
    const out = [];
    const cx = Math.floor(n.lat / 0.0025);
    const cy = Math.floor(n.lng / 0.0035);
    for (let x = cx - 1; x <= cx + 1; x++) {
      for (let y = cy - 1; y <= cy + 1; y++) {
        for (const j of grid.get(`${x},${y}`) ?? []) {
          if (j === i) continue;
          const meters = metersBetween(n, nodes[j]);
          if (meters <= TRANSFER_RADIUS_M) {
            const walked = meters * DETOUR_FACTOR;
            out.push({ to: j, meters: walked, seconds: Math.round((walked / WALK_METERS_PER_MIN) * 60) });
          }
        }
      }
    }
    return out;
  });

  const isActive = (trip, dateKey) => {
    if (trip.serviceId.startsWith('rpi:')) {
      return shuttle.schedule?.[WEEKDAY_NAMES[weekdayOf(dateKey)]] === trip.serviceId.slice(4);
    }
    return feed.activeServices(dateKey).has(trip.serviceId);
  };
  const dayCache = new Map();
  const tripsOn = (pattern, dateKey) => {
    let byPattern = dayCache.get(dateKey);
    if (!byPattern) {
      if (dayCache.size > 12) dayCache.clear();
      byPattern = new Map();
      dayCache.set(dateKey, byPattern);
    }
    let list = byPattern.get(pattern.index);
    if (!list) {
      list = pattern.trips.filter((t) => isActive(t, dateKey));
      byPattern.set(pattern.index, list);
    }
    return list;
  };

  /** The first trip that can be boarded at `pos` at or after `seconds` (from today's midnight). */
  function earliestTrip(pattern, pos, seconds, today) {
    const base = Math.floor(seconds / DAY_S);
    let best = null;
    for (let day = base - 1; day <= base + 1; day++) {
      const list = tripsOn(pattern, addDays(today, day));
      const local = seconds - day * DAY_S;
      // Sorted by first departure; a bus rarely overtakes another, so step back a little.
      let lo = 0;
      let hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid].dep[pos] < local) lo = mid + 1;
        else hi = mid;
      }
      for (let i = Math.max(0, lo - 2); i < list.length && i < lo + 4; i++) {
        const trip = list[i];
        const dep = trip.dep[pos];
        if (dep < local || (trip.flags && trip.flags[pos] & FLAG_NO_PICKUP)) continue;
        const absolute = dep + day * DAY_S;
        if (!best || absolute < best.absolute) best = { trip, day, absolute };
      }
    }
    return best;
  }

  /** Later departures on the same pattern, for "if you miss this one". */
  function laterDepartures(pattern, pos, afterSeconds, today) {
    const out = [];
    let at = afterSeconds + 1;
    while (out.length < MAX_LATER) {
      const next = earliestTrip(pattern, pos, at, today);
      if (!next || next.absolute - afterSeconds > 6 * 3600) break;
      out.push(next.absolute / 60);
      at = next.absolute + 1;
    }
    return out;
  }

  /**
   * With `prune` off, it keeps exploring after finding the fastest way there, so the
   * labels can answer questions about routes that aren't the fastest.
   */
  function raptor(access, egress, startSeconds, today, { prune = true, boardings = MAX_BOARDINGS } = {}) {
    const count = nodes.length;
    const best = new Float64Array(count).fill(Infinity);
    const labels = [new Float64Array(count).fill(Infinity)];
    const parents = [new Map()];
    let marked = new Set();
    for (const a of access) {
      const at = startSeconds + a.minutes * 60;
      if (at < labels[0][a.node]) {
        labels[0][a.node] = at;
        best[a.node] = at;
        parents[0].set(a.node, { type: 'access', access: a });
        marked.add(a.node);
      }
    }
    const limit = startSeconds + SEARCH_HORIZON_S;
    let bestAtTarget = Infinity;
    const results = [];

    for (let k = 1; k <= boardings && marked.size; k++) {
      const previous = labels[k - 1];
      const current = previous.slice();
      const parent = new Map();
      labels.push(current);
      parents.push(parent);

      const queue = new Map();
      for (const node of marked) {
        const list = patternsAtNode[node];
        for (let i = 0; i < list.length; i += 2) {
          const seen = queue.get(list[i]);
          if (seen === undefined || list[i + 1] < seen) queue.set(list[i], list[i + 1]);
        }
      }

      const reached = new Set();
      for (const [p, fromPos] of queue) {
        const pattern = patterns[p];
        let ride = null;
        let boardPos = -1;
        for (let pos = fromPos; pos < pattern.stops.length; pos++) {
          const node = pattern.stops[pos];
          if (ride) {
            const at = ride.trip.arr[pos] + ride.day * DAY_S;
            const canAlight = !(ride.trip.flags && ride.trip.flags[pos] & FLAG_NO_DROPOFF);
            if (canAlight && at < best[node] && at < bestAtTarget && at < limit) {
              current[node] = at;
              best[node] = at;
              parent.set(node, { type: 'ride', pattern, trip: ride.trip, day: ride.day, boardPos, alightPos: pos, from: pattern.stops[boardPos] });
              reached.add(node);
            }
          }
          const ready = previous[node];
          if (ready !== Infinity) {
            const earliest = ready + (k === 1 ? BOARDING_BUFFER_S : CONNECTION_BUFFER_S);
            const currentDep = ride ? ride.trip.dep[pos] + ride.day * DAY_S : Infinity;
            if (earliest <= currentDep) {
              const candidate = earliestTrip(pattern, pos, earliest, today);
              if (candidate && candidate.absolute < currentDep && candidate.absolute < limit) {
                ride = candidate;
                boardPos = pos;
              }
            }
          }
        }
      }

      // One walk after each ride, never two in a row. Each walk remembers the ride it
      // follows, since a stop's own label can be replaced by a quicker walk to it.
      const afterRides = [...reached].map((node) => ({ node, at: current[node], ride: parent.get(node) }));
      for (const { node, at, ride } of afterRides) {
        for (const walk of footpaths[node]) {
          const arrive = at + walk.seconds;
          if (arrive < best[walk.to] && arrive < bestAtTarget) {
            current[walk.to] = arrive;
            best[walk.to] = arrive;
            parent.set(walk.to, { type: 'walk', from: node, via: ride, meters: walk.meters, seconds: walk.seconds });
            reached.add(walk.to);
          }
        }
      }
      marked = reached;

      if (!prune) continue;
      let target = null;
      for (const e of egress) {
        // Only where a bus actually stops: the walk to the destination starts there.
        if (parent.get(e.node)?.type !== 'ride') continue;
        const arrive = current[e.node] + e.minutes * 60;
        if (arrive < bestAtTarget) {
          bestAtTarget = arrive;
          target = e;
        }
      }
      if (target) results.push({ rounds: k, target, chain: unwind(parents, k, target.node) });
    }
    return { results, labels, parents };
  }

  /**
   * The best trip ending on each route that stops near the destination, so a slower bus
   * still shows up as an option rather than losing out to the fastest one. It can be
   * reached directly or with one change.
   */
  function routeOptions(access, egress, startSeconds, today) {
    const { labels, parents } = raptor(access, egress, startSeconds, today, { prune: false, boardings: 1 });
    const limit = startSeconds + SEARCH_HORIZON_S;
    const egressAt = new Map(egress.map((e) => [e.node, e]));
    const candidatePatterns = new Set();
    for (const e of egress) {
      const list = patternsAtNode[e.node];
      for (let i = 0; i < list.length; i += 2) candidatePatterns.add(list[i]);
    }
    const bestByRoute = new Map();
    for (const p of candidatePatterns) {
      const pattern = patterns[p];
      const routeId = pattern.trips[0].route.id;
      for (let k = 0; k < labels.length; k++) {
        const ready = labels[k];
        const buffer = k === 0 ? BOARDING_BUFFER_S : CONNECTION_BUFFER_S;
        let ride = null;
        for (let pos = 0; pos < pattern.stops.length; pos++) {
          const node = pattern.stops[pos];
          const e = egressAt.get(node);
          if (ride && e && !(ride.trip.flags && ride.trip.flags[pos] & FLAG_NO_DROPOFF)) {
            const arrive = ride.trip.arr[pos] + ride.day * DAY_S;
            if (arrive < limit) {
              // Of the stops where this bus can be caught, use the one you reach first.
              let boardPos = -1;
              for (let q = 0; q < pos; q++) {
                const at = ready[pattern.stops[q]];
                if (at === Infinity || at + buffer > ride.trip.dep[q] + ride.day * DAY_S) continue;
                if (ride.trip.flags && ride.trip.flags[q] & FLAG_NO_PICKUP) continue;
                if (boardPos === -1 || at < ready[pattern.stops[boardPos]]) boardPos = q;
              }
              if (boardPos !== -1) {
                const accessMinutes = k === 0 ? (ready[pattern.stops[boardPos]] - startSeconds) / 60 : 0;
                const cost = (arrive + e.minutes * 60) / 60 + (e.minutes + accessMinutes) * WALK_COST_WEIGHT + k * CHANGE_COST_MIN;
                const current = bestByRoute.get(routeId);
                if (!current || cost < current.cost) {
                  bestByRoute.set(routeId, { cost, k, pattern, trip: ride.trip, day: ride.day, boardPos, alightPos: pos, target: e });
                }
              }
            }
          }
          if (ready[node] !== Infinity) {
            const earliest = ready[node] + buffer;
            const currentDep = ride ? ride.trip.dep[pos] + ride.day * DAY_S : Infinity;
            if (earliest <= currentDep) {
              const candidate = earliestTrip(pattern, pos, earliest, today);
              if (candidate && candidate.absolute < currentDep && candidate.absolute < limit) ride = candidate;
            }
          }
        }
      }
    }
    return [...bestByRoute.values()].flatMap(({ k, pattern, trip, day, boardPos, alightPos, target }) => {
      const boardNode = pattern.stops[boardPos];
      const before = unwind(parents, k, boardNode);
      // Getting off a bus only to catch the same route again isn't a real option.
      if (before.some((step) => step.type === 'ride' && step.trip.route.id === trip.route.id)) return [];
      const ride = { type: 'ride', pattern, trip, day, boardPos, alightPos, from: boardNode, node: pattern.stops[alightPos] };
      return [{ target, chain: [...before, ride] }];
    });
  }

  function unwind(parents, rounds, node) {
    const steps = [];
    let k = rounds;
    let at = node;
    while (k >= 0) {
      const parent = parents[k].get(at);
      if (!parent) {
        k--;
        continue;
      }
      if (parent.type === 'access') {
        steps.push(parent);
        break;
      }
      if (parent.type === 'walk') {
        steps.push({ ...parent, node: at });
        steps.push({ ...parent.via, node: parent.from });
        at = parent.via.from;
      } else {
        steps.push({ ...parent, node: at });
        at = parent.from;
      }
      k--;
    }
    return steps.reverse();
  }

  const ref = (node) => {
    const n = nodes[node];
    return { id: n.id, name: n.name, lat: n.lat, lng: n.lng, isReturn: n.isReturn || undefined };
  };

  function ridePath(step) {
    if (step.trip.gtfsIndex >= 0) return shapeBetween(feed, step.trip.gtfsIndex, step.boardPos, step.alightPos);
    return (rpiLines.get(step.trip.route.id) ?? []).slice(step.boardPos, step.alightPos).flat();
  }

  function toItinerary(result, from, to, today) {
    const legs = [];
    for (const step of result.chain) {
      if (step.type === 'access') {
        const stop = ref(step.access.node);
        legs.push({ kind: 'walk', from, to: stop, fromName: from.name, toName: stop.name, minutes: step.access.minutes, meters: step.access.meters, estimated: step.access.estimated || undefined, startMin: 0 });
      } else if (step.type === 'walk') {
        const a = ref(step.from);
        const b = ref(step.node);
        legs.push({ kind: 'walk', from: a, to: b, fromName: a.name, toName: b.name, minutes: step.seconds / 60, meters: step.meters, estimated: true, startMin: 0 });
      } else {
        const { trip, day, boardPos, alightPos, pattern } = step;
        const departSeconds = trip.dep[boardPos] + day * DAY_S;
        const passed = [];
        for (let pos = boardPos + 1; pos < alightPos; pos++) {
          const stop = ref(pattern.stops[pos]);
          passed.push({ id: stop.id, name: stop.name, lat: stop.lat, lng: stop.lng });
        }
        legs.push({
          kind: 'ride',
          agency: trip.route.agency,
          routeId: trip.route.id,
          routeShort: trip.route.short,
          routeName: trip.route.name,
          color: trip.route.color,
          textColor: trip.route.textColor,
          headsign: trip.headsign,
          tripId: trip.id,
          serviceDate: addDays(today, day),
          board: ref(pattern.stops[boardPos]),
          alight: ref(pattern.stops[alightPos]),
          departMin: departSeconds / 60,
          arriveMin: (trip.arr[alightPos] + day * DAY_S) / 60,
          stopsPassed: passed,
          path: ridePath(step),
          later: laterDepartures(pattern, boardPos, departSeconds, today),
        });
      }
    }
    const lastStop = result.target;
    const stop = ref(lastStop.node);
    legs.push({ kind: 'walk', from: stop, to, fromName: stop.name, toName: to.name, minutes: lastStop.minutes, meters: lastStop.meters, estimated: lastStop.estimated || undefined, startMin: 0 });
    return finishItinerary(legs);
  }

  function finishItinerary(allLegs) {
    const legs = allLegs.filter((l) => l.kind === 'ride' || l.meters >= MIN_WALK_LEG_METERS);
    let clock = null;
    // Walks take their time from the leg before; the first walk ends as the first bus leaves.
    legs.forEach((leg, i) => {
      if (leg.kind === 'ride') clock = leg.arriveMin;
      else if (i === 0) {
        const next = legs[1];
        leg.startMin = next.departMin - BOARDING_BUFFER_S / 60 - leg.minutes;
      } else {
        leg.startMin = clock;
        clock += leg.minutes;
      }
    });
    const rides = legs.filter((l) => l.kind === 'ride');
    const walks = legs.filter((l) => l.kind === 'walk');
    const first = legs[0];
    const last = legs[legs.length - 1];
    return {
      id: `transit:${rides.map((r) => `${r.routeId}@${r.board.id}>${r.alight.id}`).join('+')}`,
      kind: 'transit',
      legs,
      leaveMin: first.kind === 'walk' ? first.startMin : first.departMin - BOARDING_BUFFER_S / 60,
      arriveMin: last.kind === 'walk' ? last.startMin + last.minutes : last.arriveMin,
      walkMinutes: walks.reduce((sum, w) => sum + w.minutes, 0),
      walkMeters: walks.reduce((sum, w) => sum + w.meters, 0),
      hasTransfer: rides.length > 1,
      hasEstimatedWalk: walks.some((w) => w.estimated && w.meters >= 200),
    };
  }

  return {
    nodeIndex,
    /**
     * `access` and `egress` are lists of { stopId, minutes, meters, estimated }.
     * Returns itineraries that use at least one CDTA bus; the browser's own planner
     * covers trips on the shuttles alone.
     */
    plan({ from, to, startMin, access, egress, today }) {
      const resolve = (list) =>
        list.flatMap((w) => {
          const node = nodeIndex.get(w.stopId);
          return node === undefined ? [] : [{ ...w, node }];
        });
      const allAccess = resolve(access);
      const allEgress = resolve(egress);
      const found = new Map();
      const keep = (result) => {
        const itinerary = toItinerary(result, from, to, today);
        if (!itinerary.legs.some((l) => l.kind === 'ride' && l.agency === 'cdta')) return;
        if (!found.has(itinerary.id)) found.set(itinerary.id, itinerary);
      };
      for (const limit of WALK_LIMITS_M) {
        const a = allAccess.filter((w) => w.meters <= limit);
        const e = allEgress.filter((w) => w.meters <= limit);
        if (!a.length || !e.length) continue;
        for (const result of raptor(a, e, startMin * 60, today).results) keep(result);
      }
      const nearDestination = allEgress.filter((w) => w.meters <= ROUTE_OPTION_WALK_M);
      if (allAccess.length && nearDestination.length) {
        for (const result of routeOptions(allAccess, nearDestination, startMin * 60, today)) keep(result);
      }
      return [...found.values()];
    },
  };
}
