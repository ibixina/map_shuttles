// Works out how to get from A to B: walk to a stop, ride, optionally change at the
// Student Union (where both loops start and end), walk the rest. Every route is a
// one-way loop, so a stop can only reach the stops after it in the same run.
import { metersBetween, type LatLng } from './geo';
import { pathBetween, stopsBetween, type LngLat, type Network, type Route, type Stop } from './network';
import type { Timetable } from './time';

export interface WalkEstimate {
  minutes: number;
  meters: number;
  /** A straight-line guess rather than a time from a routing server. */
  estimated?: boolean;
}
export type WalkFn = (a: LatLng, b: LatLng) => WalkEstimate;

export interface WalkLeg extends WalkEstimate {
  kind: 'walk';
  from: LatLng;
  to: LatLng;
  fromName: string;
  toName: string;
  startMin: number;
}
/** A stop as a trip refers to it; shuttle and CDTA stops both fit this. */
export interface StopRef extends LatLng {
  id: string;
  name: string;
  key?: string;
  index?: number;
  isReturn?: boolean;
}
export interface RideLeg {
  kind: 'ride';
  agency: 'rpi' | 'cdta';
  routeId: string;
  routeShort: string;
  routeName: string;
  color: string;
  textColor: string;
  headsign?: string;
  board: StopRef;
  alight: StopRef;
  departMin: number;
  arriveMin: number;
  stopsPassed: StopRef[];
  path: LngLat[];
  /** CDTA's live prediction for the boarding stop, when it has one. */
  liveDepartMin?: number;
  /** Later departures from the boarding stop, in case this one is missed. */
  later: number[];
}
export type Leg = WalkLeg | RideLeg;

export interface Trip {
  /** Stable across re-planning, so the selected option survives a clock tick. */
  id: string;
  /** 'transit' trips use CDTA, possibly along with a shuttle; 'shuttle' trips use shuttles only. */
  kind: 'walk' | 'shuttle' | 'transit';
  legs: Leg[];
  leaveMin: number;
  arriveMin: number;
  walkMinutes: number;
  walkMeters: number;
  hasTransfer: boolean;
  /** At least one walking time is a rough guess. */
  hasEstimatedWalk: boolean;
}

export interface PlanResult {
  trips: Trip[];
  /** Closest stop to the destination, for explaining why the shuttle may not help. */
  nearestToDestination: { stop: Stop; meters: number } | null;
  nearestToOrigin: { stop: Stop; meters: number } | null;
  /** Too far from either end for the shuttle to be any use. */
  outOfRange: boolean;
}

export interface Endpoint extends LatLng {
  name: string;
}

export interface PlanInput {
  from: Endpoint;
  to: Endpoint;
  /** Absolute minutes to start at. */
  startMin: number;
  network: Network;
  timetable: Timetable;
  walk: WalkFn;
}

const WALK_METERS_PER_MIN = 75;
/** Shorter than this isn't a walk: you're already there. */
const MIN_WALK_LEG_METERS = 20;
const DETOUR_FACTOR = 1.25;
/** A guess this short (say, across the Union to the other loop's stop) isn't worth a warning. */
const NOTABLE_ESTIMATE_METERS = 200;
/** Get to the stop a little early: buses run to a schedule, not a guarantee. */
const BOARDING_BUFFER_MIN = 1;
const TRANSFER_PENALTY_MIN = 4;
/** People will accept a slightly later arrival for less walking. */
const WALK_COST_WEIGHT = 0.5;
const MAX_WALK_LEG_METERS = 4_000;
const MAX_WALK_ONLY_METERS = 8_000;
const OUT_OF_RANGE_METERS = 10_000;
/** Don't show shuttle options arriving this much later than the best shuttle option. */
const MAX_LATER_THAN_BEST_MIN = 45;
const MAX_TRIPS = 4;

/** Rough straight-line walking estimate, used until real paths are available. */
export function estimateWalk(a: LatLng, b: LatLng): WalkEstimate {
  const meters = metersBetween(a, b) * DETOUR_FACTOR;
  return { meters, minutes: meters / WALK_METERS_PER_MIN, estimated: true };
}

function nearest(point: LatLng, stops: Stop[]): { stop: Stop; meters: number } | null {
  let best: { stop: Stop; meters: number } | null = null;
  for (const stop of stops) {
    const meters = metersBetween(point, stop);
    if (!best || meters < best.meters) best = { stop, meters };
  }
  return best;
}

function walkLeg(estimate: WalkEstimate, from: Endpoint, to: Endpoint, startMin: number): WalkLeg {
  return { kind: 'walk', ...estimate, from, to, fromName: from.name, toName: to.name, startMin };
}

function rideLeg(route: Route, board: Stop, alight: Stop, runDeparture: number, timetable: Timetable): RideLeg {
  const later = timetable.upcoming(route.id, runDeparture + 0.01, 3).map((t) => t + board.offset);
  return {
    kind: 'ride',
    agency: 'rpi',
    routeId: route.id,
    routeShort: route.name.replace(' Route', ''),
    routeName: route.name,
    color: route.color,
    textColor: '#ffffff',
    board,
    alight,
    departMin: runDeparture + board.offset,
    arriveMin: runDeparture + alight.offset,
    stopsPassed: stopsBetween(route, board, alight),
    path: pathBetween(route, board, alight),
    later,
  };
}

function finishTrip(id: string, allLegs: Leg[]): Trip {
  // Keep a lone walk, however short: it is the whole trip.
  const legs = allLegs.length === 1 ? allLegs : allLegs.filter((l) => l.kind === 'ride' || l.meters >= MIN_WALK_LEG_METERS);
  const walks = legs.filter((l): l is WalkLeg => l.kind === 'walk');
  const firstRide = legs.find((l): l is RideLeg => l.kind === 'ride');
  const first = legs[0];
  const last = legs[legs.length - 1];
  let leaveMin: number;
  if (!firstRide) leaveMin = (first as WalkLeg).startMin;
  else if (first.kind === 'walk') {
    // Leave just in time for the bus, rather than at the moment of planning.
    leaveMin = firstRide.departMin - BOARDING_BUFFER_MIN - first.minutes;
    first.startMin = leaveMin;
  } else leaveMin = firstRide.departMin - BOARDING_BUFFER_MIN;
  return {
    id,
    kind: firstRide ? 'shuttle' : 'walk',
    legs,
    leaveMin,
    arriveMin: last.kind === 'walk' ? last.startMin + last.minutes : last.arriveMin,
    walkMinutes: walks.reduce((sum, w) => sum + w.minutes, 0),
    walkMeters: walks.reduce((sum, w) => sum + w.meters, 0),
    hasTransfer: legs.filter((l) => l.kind === 'ride').length > 1,
    hasEstimatedWalk: walks.some((w) => w.estimated && w.meters >= NOTABLE_ESTIMATE_METERS),
  };
}

export const tripCost = (t: Trip) => {
  const changes = Math.max(0, t.legs.filter((l) => l.kind === 'ride').length - 1);
  return t.arriveMin + t.walkMinutes * WALK_COST_WEIGHT + changes * TRANSFER_PENALTY_MIN;
};

export function planTrips({ from, to, startMin, network, timetable, walk }: PlanInput): PlanResult {
  const stops = network.boardingStops;
  const nearestToDestination = nearest(to, stops);
  const nearestToOrigin = nearest(from, stops);
  const outOfRange =
    (nearestToDestination?.meters ?? Infinity) > OUT_OF_RANGE_METERS || (nearestToOrigin?.meters ?? Infinity) > OUT_OF_RANGE_METERS;

  const walkOnly = walk(from, to);
  const trips: Trip[] = [];
  if (walkOnly.meters <= MAX_WALK_ONLY_METERS) {
    trips.push(finishTrip('walk', [walkLeg(walkOnly, from, to, startMin)]));
  }

  if (!outOfRange) {
    const bestByGroup = new Map<string, { trip: Trip; cost: number }>();
    const consider = (group: string, trip: Trip) => {
      // A shuttle trip with as much walking as just walking there is no help.
      if (trip.walkMeters >= walkOnly.meters) return;
      const cost = tripCost(trip);
      const current = bestByGroup.get(group);
      if (!current || cost < current.cost) bestByGroup.set(group, { trip, cost });
    };

    const access = new Map(network.routes.flatMap((r) => r.stops).map((s) => [s.id, walk(from, s)]));
    const egress = new Map(network.routes.flatMap((r) => r.stops).map((s) => [s.id, walk(s, to)]));
    const usable = (w: WalkEstimate | undefined): w is WalkEstimate => !!w && w.meters <= MAX_WALK_LEG_METERS;

    for (const first of network.routes) {
      const unionReturn = first.stops.at(-1)!;
      for (const board of first.stops) {
        if (board.isReturn) continue;
        const toStop = access.get(board.id);
        if (!usable(toStop)) continue;
        const atStop = startMin + toStop.minutes + BOARDING_BUFFER_MIN;
        const run = timetable.next(first.id, atStop - board.offset);
        if (run == null) continue;
        const ride = rideLeg(first, board, unionReturn, run, timetable);
        const startWalk = walkLeg(toStop, from, board, startMin);

        // Direct: get off at any later stop on this run.
        for (const alight of first.stops) {
          if (alight.index <= board.index) continue;
          const fromStop = egress.get(alight.id);
          if (!usable(fromStop)) continue;
          const leg = rideLeg(first, board, alight, run, timetable);
          consider(first.id, finishTrip(`direct:${first.id}`, [{ ...startWalk }, leg, walkLeg(fromStop, alight, to, leg.arriveMin)]));
        }

        // Change at the Student Union onto the start of any route's next run.
        if (board.index === 0) continue;
        for (const second of network.routes) {
          const secondStart = second.stops[0];
          const change = second.id === first.id ? { minutes: 0, meters: 0 } : walk(unionReturn, secondStart);
          const secondRun = timetable.next(second.id, ride.arriveMin + change.minutes + BOARDING_BUFFER_MIN);
          if (secondRun == null) continue;
          for (const alight of second.stops) {
            if (alight.index === 0 || alight.isReturn) continue;
            const fromStop = egress.get(alight.id);
            if (!usable(fromStop)) continue;
            const secondLeg = rideLeg(second, secondStart, alight, secondRun, timetable);
            const legs: Leg[] = [{ ...startWalk }, ride];
            if (change.meters > 0) legs.push(walkLeg(change, unionReturn, secondStart, ride.arriveMin));
            legs.push(secondLeg, walkLeg(fromStop, alight, to, secondLeg.arriveMin));
            consider(`${first.id}>${second.id}`, finishTrip(`change:${first.id}:${second.id}`, legs));
          }
        }
      }
    }
    const candidates = [...bestByGroup.values()].map((b) => b.trip);
    // Changing buses must earn its place: drop it if some direct trip gets there as
    // soon with no more walking. Arriving a little later to skip a long walk is fair.
    const direct = candidates.filter((t) => !t.hasTransfer);
    const beaten = (t: Trip) => direct.some((d) => d.arriveMin <= t.arriveMin && d.walkMeters <= t.walkMeters);
    trips.push(...candidates.filter((t) => !t.hasTransfer || !beaten(t)));
  }

  trips.sort((a, b) => tripCost(a) - tripCost(b));
  // Compared only among shuttle trips: even when walking is much quicker (say, late at
  // night), "the first bus is tomorrow at 7:00 AM" is still worth showing.
  const shuttleArrivals = trips.filter((t) => t.kind === 'shuttle').map((t) => t.arriveMin);
  const earliestShuttle = Math.min(...shuttleArrivals);
  return {
    trips: trips.filter((t) => t.kind === 'walk' || t.arriveMin - earliestShuttle <= MAX_LATER_THAN_BEST_MIN).slice(0, MAX_TRIPS),
    nearestToDestination,
    nearestToOrigin,
    outOfRange,
  };
}

const MAX_MERGED_TRIPS = 8;
/** A bus getting you there this much later than the quickest bus isn't a useful suggestion. */
const MAX_LATER_THAN_QUICKEST_MIN = 120;

/** The route a trip finishes on, written the same for both planners. */
function lastRoute(trip: Trip): string {
  const rides = trip.legs.filter((l): l is RideLeg => l.kind === 'ride');
  return (rides.at(-1)?.routeId ?? '').replace(/^rpi:/, '');
}

/**
 * Every useful way to get there, best first: walking, plus the best trip ending on each
 * route. A trip with as much walking as just walking there is left out.
 */
export function mergeTrips(shuttleTrips: Trip[], transitTrips: Trip[]): Trip[] {
  const all = [...shuttleTrips, ...transitTrips];
  const walking = all.filter((t) => t.kind === 'walk');
  const walkOnly = walking[0]?.walkMeters ?? Infinity;
  const bestByRoute = new Map<string, Trip>();
  for (const trip of all) {
    if (trip.kind === 'walk' || trip.walkMeters >= walkOnly) continue;
    const key = lastRoute(trip);
    const current = bestByRoute.get(key);
    if (!current || tripCost(trip) < tripCost(current)) bestByRoute.set(key, trip);
  }
  const buses = [...bestByRoute.values()];
  const earliest = Math.min(...buses.map((t) => t.arriveMin));
  return [...walking, ...buses.filter((t) => t.arriveMin - earliest <= MAX_LATER_THAN_QUICKEST_MIN)]
    .sort((a, b) => tripCost(a) - tripCost(b))
    .slice(0, MAX_MERGED_TRIPS);
}
