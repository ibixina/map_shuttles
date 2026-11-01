// Real walking times and paths from public routing servers. Valhalla comes first
// (better footpath handling and wording, such as "Take the stairs"), then OSRM, then
// a straight-line estimate that the UI labels as such.
import { metersBetween, type LatLng } from './geo';
import { estimateWalk, type WalkEstimate, type WalkFn } from './planner';
import type { LngLat } from './network';

const VALHALLA = 'https://valhalla1.openstreetmap.de';
const OSRM = 'https://routing.openstreetmap.de/routed-foot';
const PROVIDER_TIMEOUT_MS = 3_500;
/** After a failure, skip that server for a while rather than waiting on it every time. */
const FAILURE_BACKOFF_MS = 60_000;
/** Beyond this, a walking table isn't useful and just burns a shared server's time. */
const MAX_TABLE_METERS = 30_000;
const MIN_ROUTABLE_METERS = 15;

const key = (p: LatLng) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
export const walkPathKey = (a: LatLng, b: LatLng) => `${key(a)}>${key(b)}`;
const toLocation = (p: LatLng) => ({ lat: p.lat, lon: p.lng });
const osrmCoord = (p: LatLng) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`;

const known = new Map<string, WalkEstimate>();

export const walkTime: WalkFn = (a, b) => known.get(walkPathKey(a, b)) ?? estimateWalk(a, b);

// --- Provider failover ----------------------------------------------------------------

const downUntil = new Map<string, number>();

/** Tries each provider in order, returning the first answer, or null if none answers. */
async function firstAnswer<T>(attempts: [string, (signal: AbortSignal) => Promise<T>][], outer?: AbortSignal): Promise<T | null> {
  for (const [name, attempt] of attempts) {
    if (outer?.aborted) return null;
    if ((downUntil.get(name) ?? 0) > Date.now()) continue;
    const timeout = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
    try {
      return await attempt(outer ? AbortSignal.any([outer, timeout]) : timeout);
    } catch {
      if (!outer?.aborted) downUntil.set(name, Date.now() + FAILURE_BACKOFF_MS);
    }
  }
  return null;
}

async function getJson(url: string, signal: AbortSignal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

const valhallaUrl = (endpoint: string, body: unknown) => `${VALHALLA}/${endpoint}?json=${encodeURIComponent(JSON.stringify(body))}`;

// --- Time tables: from the start to every stop, and from every stop to the end -----------

interface Cell {
  source: number;
  target: number;
  minutes: number;
  meters: number;
}

async function valhallaTable(sources: LatLng[], targets: LatLng[], signal: AbortSignal): Promise<Cell[]> {
  const json = await getJson(
    valhallaUrl('sources_to_targets', {
      sources: sources.map(toLocation),
      targets: targets.map(toLocation),
      costing: 'pedestrian',
      units: 'kilometers',
    }),
    signal,
  );
  const rows = json.sources_to_targets as { from_index: number; to_index: number; time: number | null; distance: number | null }[][];
  if (!rows) throw new Error('bad response');
  return rows.flat().flatMap((c) =>
    c.time == null || c.distance == null ? [] : [{ source: c.from_index, target: c.to_index, minutes: c.time / 60, meters: c.distance * 1000 }],
  );
}

async function osrmTable(sources: LatLng[], targets: LatLng[], signal: AbortSignal): Promise<Cell[]> {
  const points = [...sources, ...targets];
  const sourceIndexes = sources.map((_, i) => i).join(';');
  const targetIndexes = targets.map((_, i) => i + sources.length).join(';');
  const json = await getJson(
    `${OSRM}/table/v1/foot/${points.map(osrmCoord).join(';')}?sources=${sourceIndexes}&destinations=${targetIndexes}&annotations=duration,distance`,
    signal,
  );
  if (json.code !== 'Ok') throw new Error(json.code);
  const cells: Cell[] = [];
  sources.forEach((_, s) => {
    targets.forEach((_, t) => {
      const seconds = json.durations[s][t];
      const meters = json.distances[s][t];
      if (seconds != null && meters != null) cells.push({ source: s, target: t, minutes: seconds / 60, meters });
    });
  });
  return cells;
}

async function loadTable(sources: LatLng[], targets: LatLng[], signal?: AbortSignal) {
  const cells = await firstAnswer(
    [
      ['valhalla', (s) => valhallaTable(sources, targets, s)],
      ['osrm', (s) => osrmTable(sources, targets, s)],
    ],
    signal,
  );
  for (const cell of cells ?? []) {
    known.set(walkPathKey(sources[cell.source], targets[cell.target]), { minutes: cell.minutes, meters: cell.meters });
  }
}

/** Loads walking times from `from` to `access` stops, and from `egress` stops to `to`. Never throws. */
export async function prepareWalkTimes(from: LatLng, to: LatLng, access: LatLng[], egress: LatLng[], signal?: AbortSignal): Promise<void> {
  const unique = (list: LatLng[]) => [...new Map(list.map((s) => [key(s), s])).values()];
  const starts = unique(access);
  const ends = unique(egress);
  const inRange = (p: LatLng, list: LatLng[]) => list.some((s) => metersBetween(p, s) < MAX_TABLE_METERS);
  const missing = (a: LatLng, b: LatLng) => !known.has(walkPathKey(a, b));
  const jobs: Promise<void>[] = [];
  if (inRange(from, starts) && (missing(from, to) || starts.some((s) => missing(from, s)))) {
    jobs.push(loadTable([from], [...starts, to], signal));
  }
  if (inRange(to, ends) && ends.some((s) => missing(s, to))) {
    jobs.push(loadTable(ends, [to], signal));
  }
  await Promise.allSettled(jobs);
}

// --- A single walking path, for drawing and turn-by-turn text -------------------------------

export interface WalkStepText {
  text: string;
  meters: number;
}

export interface WalkPath {
  coords: LngLat[];
  meters: number;
  minutes: number;
  /** Turn-by-turn text; empty if only an estimate is available. */
  steps: WalkStepText[];
  /** A straight line rather than a real path: buildings may be in the way. */
  isEstimate: boolean;
}

/** Decodes an encoded polyline with six decimal places, as Valhalla returns. */
export function decodePolyline6(encoded: string): LngLat[] {
  const coords: LngLat[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    lat += next();
    lng += next();
    coords.push([lng / 1e6, lat / 1e6]);
  }
  return coords;
}

interface ValhallaManeuver {
  instruction: string;
  length: number;
  type: number;
}
/** Valhalla's "you have arrived" maneuver types. */
const VALHALLA_ARRIVE = new Set([4, 5, 6]);

export function stepsFromValhalla(maneuvers: ValhallaManeuver[]): WalkStepText[] {
  return maneuvers
    .filter((m) => !VALHALLA_ARRIVE.has(m.type))
    .map((m) => ({ text: m.instruction.replace(/\.$/, ''), meters: m.length * 1000 }));
}

interface OsrmStep {
  name?: string;
  distance: number;
  maneuver: { type: string; modifier?: string };
}

function describeOsrmStep(step: OsrmStep): string | null {
  const { type, modifier } = step.maneuver;
  const name = step.name?.trim();
  const onto = name ? ` onto ${name}` : '';
  switch (type) {
    case 'depart':
      return name ? `Start on ${name}` : 'Start walking';
    case 'arrive':
      return null;
    case 'turn':
    case 'end of road':
    case 'fork':
    case 'merge':
    case 'on ramp':
    case 'off ramp':
      if (!modifier || modifier === 'straight') return `Continue${onto}`;
      if (modifier === 'uturn') return `Turn around${onto}`;
      return `${modifier.startsWith('slight') ? 'Bear' : modifier.startsWith('sharp') ? 'Turn sharply' : 'Turn'} ${modifier.replace(/^(slight|sharp) /, '')}${onto}`;
    default:
      return name ? `Continue on ${name}` : 'Continue straight';
  }
}

export function stepsFromOsrm(raw: OsrmStep[]): WalkStepText[] {
  const steps: WalkStepText[] = [];
  for (const step of raw) {
    const text = describeOsrmStep(step);
    if (!text) continue;
    const previous = steps[steps.length - 1];
    // Unnamed path fragments add noise: fold them into the step before.
    if (previous && text.startsWith('Continue') && !step.name?.trim()) previous.meters += step.distance;
    else steps.push({ text, meters: step.distance });
  }
  return steps;
}

async function valhallaPath(a: LatLng, b: LatLng, signal: AbortSignal): Promise<WalkPath> {
  const json = await getJson(valhallaUrl('route', { locations: [toLocation(a), toLocation(b)], costing: 'pedestrian', units: 'kilometers' }), signal);
  const leg = json.trip?.legs?.[0];
  if (!leg) throw new Error('no route');
  return {
    coords: decodePolyline6(leg.shape),
    meters: json.trip.summary.length * 1000,
    minutes: json.trip.summary.time / 60,
    steps: stepsFromValhalla(leg.maneuvers),
    isEstimate: false,
  };
}

async function osrmPath(a: LatLng, b: LatLng, signal: AbortSignal): Promise<WalkPath> {
  const json = await getJson(`${OSRM}/route/v1/foot/${osrmCoord(a)};${osrmCoord(b)}?overview=full&geometries=geojson&steps=true`, signal);
  const route = json.routes?.[0];
  if (json.code !== 'Ok' || !route) throw new Error('no route');
  return {
    coords: route.geometry.coordinates as LngLat[],
    meters: route.distance,
    minutes: route.duration / 60,
    steps: stepsFromOsrm(route.legs[0].steps),
    isEstimate: false,
  };
}

function straightLine(a: LatLng, b: LatLng): WalkPath {
  return { coords: [[a.lng, a.lat], [b.lng, b.lat]], ...walkTime(a, b), steps: [], isEstimate: true };
}

const pathCache = new Map<string, WalkPath>();

export async function fetchWalkPath(a: LatLng, b: LatLng): Promise<WalkPath> {
  // Next to each other: there is no route worth asking for, and nothing to warn about.
  if (metersBetween(a, b) < MIN_ROUTABLE_METERS) return { ...straightLine(a, b), isEstimate: false };
  const id = walkPathKey(a, b);
  const cached = pathCache.get(id);
  if (cached) return cached;
  const path = await firstAnswer([
    ['valhalla', (s) => valhallaPath(a, b, s)],
    ['osrm', (s) => osrmPath(a, b, s)],
  ]);
  if (!path) return straightLine(a, b); // Not cached, so a later attempt can still succeed.
  // Routers snap to the nearest path; join the exact endpoints back on.
  const joined: WalkPath = { ...path, coords: [[a.lng, a.lat], ...path.coords, [b.lng, b.lat]] };
  pathCache.set(id, joined);
  return joined;
}
