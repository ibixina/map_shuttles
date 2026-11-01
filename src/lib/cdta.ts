// Browser side of CDTA: types for what the server sends, and hooks to fetch it.
import { useEffect, useRef, useState } from 'react';
import { callEngine, dataUrl, LIVE_URL } from './engine';
import { metersBetween, type LatLng } from './geo';
import type { LngLat } from './network';
import type { Endpoint, Trip } from './planner';

export interface CdtaRoute {
  id: string;
  short: string;
  long: string;
  desc?: string;
  color: string;
  textColor: string;
  sort: number;
}
export interface CdtaStop extends LatLng {
  id: string;
  code: string;
  name: string;
  routes: string[];
}
export interface CdtaOverview {
  feed: { end: string; version: string };
  routes: CdtaRoute[];
  stops: CdtaStop[];
  lines: { routeId: string; coords: LngLat[] }[];
}

export interface RouteRef {
  routeId: string;
  short: string;
  long: string;
  color: string;
  textColor: string;
}
export interface CdtaVehicle extends RouteRef, LatLng {
  id: string;
  tripId: string;
  headsign: string;
  ageSeconds: number;
  status: string | null;
  stopSequence: number | null;
  occupancy: string | null;
  /** Worked out in the browser from movement: the feed doesn't send a direction. */
  heading?: number | null;
}
export interface CdtaArrival extends RouteRef {
  tripId: string;
  headsign: string;
  schedMin: number;
  liveMin: number | null;
  vehicleId: string | null;
}
export interface CdtaAlert {
  id: string;
  header: string;
  description: string;
  url: string;
}
export interface CdtaStopDetail {
  nowMin: number;
  arrivals: CdtaArrival[];
  alerts: CdtaAlert[];
}
export interface CdtaDirection {
  direction: number;
  headsign: string;
  stops: (LatLng & { id: string; name: string })[];
  path: LngLat[];
  firstMin: number | null;
  lastMin: number | null;
  tripsToday: number;
}
export interface CdtaRouteDetail extends RouteRef {
  desc: string;
  directions: CdtaDirection[];
  alerts: CdtaAlert[];
}
export interface CdtaVehicleDetail extends CdtaVehicle {
  currentStopName: string | null;
  delayMin: number | null;
  upcoming: { stopId: string; name: string; schedMin: number; liveMin: number | null }[];
}

const VEHICLE_POLL_MS = 15_000;
const OVERVIEW_RETRY_MS = 8_000;
/** Smaller moves than this are GPS jitter, not a direction of travel. */
const MIN_HEADING_MOVE_M = 15;
const ACCESS_RADIUS_M = 1_600;
const MAX_ACCESS_STOPS = 25;
const FALLBACK_RADIUS_M = 5_000;

export function bearing(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function useCdtaOverview(): CdtaOverview | null {
  const [overview, setOverview] = useState<CdtaOverview | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        const res = await fetch(dataUrl('cdta-overview.json'));
        if (!res.ok) throw new Error(`${res.status}`);
        const json = (await res.json()) as CdtaOverview;
        if (!cancelled) setOverview(json);
      } catch {
        if (!cancelled) timer = window.setTimeout(load, OVERVIEW_RETRY_MS);
      }
    };
    void load();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);
  return overview;
}

/** Repeats a request while it's wanted, pausing while the tab is hidden. A null key means "nothing wanted". */
export function usePolled<T>(key: string | null, load: () => Promise<T>, intervalMs: number): { data: T | null; failed: boolean } {
  const [state, setState] = useState<{ key: string | null; data: T | null; failed: boolean }>({ key, data: null, failed: false });
  const latest = useRef(load);
  latest.current = load;
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const run = () => {
      if (document.hidden) return;
      latest.current().then(
        (data) => {
          if (!cancelled) setState({ key, data, failed: false });
        },
        () => {
          if (!cancelled) setState((s) => (s.key === key ? { ...s, failed: true } : { key, data: null, failed: true }));
        },
      );
    };
    run();
    const timer = window.setInterval(run, intervalMs);
    document.addEventListener('visibilitychange', run);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', run);
    };
  }, [key, intervalMs]);
  // Don't show the previous stop's data while the new one loads.
  return state.key === key ? { data: state.data, failed: state.failed } : { data: null, failed: false };
}

export function useCdtaVehicles(enabled: boolean): { vehicles: CdtaVehicle[]; failed: boolean } {
  const { data, failed } = usePolled<CdtaVehicle[]>(enabled && LIVE_URL ? 'vehicles' : null, () => callEngine('vehicles'), VEHICLE_POLL_MS);
  const lastSeen = useRef(new Map<string, { at: LatLng; heading: number | null }>());
  const [vehicles, setVehicles] = useState<CdtaVehicle[]>([]);
  useEffect(() => {
    if (!enabled) {
      setVehicles([]);
      return;
    }
    if (!data) return;
    setVehicles(
      data.map((v) => {
        const seen = lastSeen.current.get(v.id);
        let heading = seen?.heading ?? null;
        let at: LatLng = seen?.at ?? v;
        if (seen && metersBetween(seen.at, v) >= MIN_HEADING_MOVE_M) {
          heading = bearing(seen.at, v);
          at = v;
        }
        lastSeen.current.set(v.id, { at, heading });
        return { ...v, heading };
      }),
    );
  }, [data, enabled]);
  return { vehicles, failed };
}

/** Stops worth asking about for a trip starting or ending at `point`, closest first. */
export function nearestCdtaStops(point: LatLng, overview: CdtaOverview, radius = ACCESS_RADIUS_M, max = MAX_ACCESS_STOPS): CdtaStop[] {
  const scored = overview.stops
    .map((stop) => ({ stop, meters: metersBetween(point, stop) }))
    .filter((s) => s.meters <= FALLBACK_RADIUS_M)
    .sort((a, b) => a.meters - b.meters);
  const close = scored.filter((s) => s.meters <= radius);
  // Somewhere with nothing close by can still use a stop further off.
  return (close.length >= 3 ? close.slice(0, max) : scored.slice(0, 3)).map((s) => s.stop);
}

export interface WalkTo {
  stopId: string;
  minutes: number;
  meters: number;
  estimated?: boolean;
}

/** Plans with CDTA and the shuttles together, in the background engine. */
export function fetchTransitTrips(input: { from: Endpoint; to: Endpoint; startMin: number; access: WalkTo[]; egress: WalkTo[] }): Promise<Trip[]> {
  return callEngine<Trip[]>('plan', input);
}
