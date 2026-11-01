// Merges the two live feeds into one per-bus status, and estimates arrivals.
import type { Network, Route, Stop } from './network';

export interface RawLocation {
  name: string;
  latitude: number;
  longitude: number;
  timestamp: string;
  heading_degrees: number;
  speed_mph: number;
  address_name: string | null;
  formatted_location?: string | null;
  address_id?: string | null;
  license_plate?: string | null;
  vin?: string | null;
  asset_type?: string | null;
  gateway_model?: string | null;
  gateway_serial?: string | null;
  is_ecu_speed?: boolean | null;
  driver?: { id?: string | null; name?: string | null } | null;
}
export interface RawVelocity {
  route_name: string | null;
  polyline_index: number | null;
  segment_index: number | null;
  is_at_stop: boolean;
  current_stop: string | null;
}
export interface RawEta {
  stop_times?: Record<string, string>;
}

export type BusState = 'on-route' | 'idle' | 'entering' | 'leaving';

export interface UpcomingStop {
  stop: Stop;
  etaMin: number;
}

/** Everything else the feed reports about a bus, as label and value, for its detail panel. */
export interface BusDetail {
  label: string;
  value: string;
}

function busDetails(loc: RawLocation): BusDetail[] {
  const rows: [string, string | null | undefined][] = [
    ['Driver', loc.driver?.name],
    ['Driver ID', loc.driver?.id],
    ['License plate', loc.license_plate],
    ['VIN', loc.vin],
    ['Asset type', loc.asset_type],
    ['Address', loc.formatted_location],
    ['Zone', loc.address_name?.trim()],
    ['Address ID', loc.address_id],
    ['Tracker model', loc.gateway_model],
    ['Tracker serial', loc.gateway_serial],
    ['Speed from engine computer', loc.is_ecu_speed == null ? null : loc.is_ecu_speed ? 'Yes' : 'No'],
  ];
  return rows.flatMap(([label, value]) => (value ? [{ label, value }] : []));
}

export interface Bus {
  id: string;
  name: string;
  lat: number;
  lng: number;
  heading: number | null;
  speedMph: number;
  state: BusState;
  route: Route | null;
  /** Name of the stop the bus is sitting at, if any. */
  atStopName: string | null;
  placeName: string | null;
  upcoming: UpcomingStop[];
  ageSeconds: number;
  /** Not heard from recently: the marker may be out of date. */
  stale: boolean;
  details: BusDetail[];
}

const STALE_AFTER_S = 180;
const HIDE_AFTER_S = 3600;

/** Minutes into the loop, from which leg the bus is on and how far along it. */
function loopPosition(route: Route, legIndex: number, segmentIndex: number): number {
  const legLength = route.legs[legIndex]?.length ?? 1;
  const start = route.stops[legIndex]?.offset ?? 0;
  const end = route.stops[legIndex + 1]?.offset ?? start;
  const fraction = Math.min(1, Math.max(0, segmentIndex / Math.max(1, legLength - 1)));
  return start + (end - start) * fraction;
}

export function buildBuses(
  locations: Record<string, RawLocation>,
  velocities: Record<string, RawVelocity>,
  etas: Record<string, RawEta>,
  network: Network,
  nowMs: number,
): Bus[] {
  const buses: Bus[] = [];
  for (const [id, loc] of Object.entries(locations)) {
    const ageSeconds = Math.max(0, (nowMs - Date.parse(loc.timestamp)) / 1000);
    if (ageSeconds > HIDE_AFTER_S) continue;
    const v = velocities[id];
    const routeName = v?.route_name ?? null;
    const route = routeName ? (network.routeById.get(routeName) ?? null) : null;

    let state: BusState = 'idle';
    if (route) state = 'on-route';
    else if (routeName?.startsWith('ENTRY')) state = 'entering';
    else if (routeName?.startsWith('EXIT')) state = 'leaving';

    const upcoming: UpcomingStop[] = [];
    let atStopName: string | null = null;
    if (v?.is_at_stop && v.current_stop) {
      const known = network.routes.flatMap((r) => r.stops).find((s) => s.key === v.current_stop && (!route || s.routeId === route.id));
      atStopName = known?.name ?? null;
    }
    if (route && v.polyline_index != null) {
      const position = loopPosition(route, v.polyline_index, v.segment_index ?? 0);
      const stopTimes = etas[id]?.stop_times ?? {};
      for (const stop of route.stops) {
        if (stop.index <= v.polyline_index) continue;
        const official = stopTimes[stop.key] ? (Date.parse(stopTimes[stop.key]) - nowMs) / 60_000 : NaN;
        const etaMin = official >= 0 ? official : Math.max(0, stop.offset - position);
        upcoming.push({ stop, etaMin });
      }
    }

    const moving = loc.speed_mph >= 1;
    buses.push({
      id,
      name: loc.name,
      lat: loc.latitude,
      lng: loc.longitude,
      heading: moving ? loc.heading_degrees : null,
      speedMph: loc.speed_mph,
      state,
      route,
      atStopName,
      // The fleet system's zone names can carry internal notes, like "(Idle Geofence)".
      placeName: loc.address_name?.replace(/\s*\([^)]*geofence[^)]*\)/i, '').trim() || null,
      upcoming,
      ageSeconds,
      stale: ageSeconds > STALE_AFTER_S,
      details: busDetails(loc),
    });
  }
  return buses.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** Buses still due at this stop on their current run, soonest first. */
export function liveArrivals(stop: Stop, buses: Bus[]): { bus: Bus; etaMin: number }[] {
  const out: { bus: Bus; etaMin: number }[] = [];
  for (const bus of buses) {
    if (bus.route?.id !== stop.routeId || bus.stale) continue;
    const hit = bus.upcoming.find((u) => u.stop.id === stop.id);
    if (hit) out.push({ bus, etaMin: hit.etaMin });
  }
  return out.sort((a, b) => a.etaMin - b.etaMin);
}

export function busStatusText(bus: Bus): string {
  if (bus.state === 'entering') return 'Heading to campus to start service';
  if (bus.state === 'leaving') return 'Leaving service';
  if (bus.state === 'idle') {
    const where = bus.atStopName ?? bus.placeName;
    return where ? `Between runs at ${where}` : 'Between runs';
  }
  if (bus.atStopName) return `Stopped at ${bus.atStopName}`;
  const next = bus.upcoming[0];
  return next ? `Next stop: ${next.stop.name}` : 'Finishing its loop';
}
