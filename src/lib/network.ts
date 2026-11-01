// Turns the raw /api/routes payload into something the map and planner can use.
//
// Raw shape, per route: STOPS (real stops, in order), ROUTES (one polyline per
// consecutive pair of STOPS, and what a bus's `polyline_index` indexes), and a
// { COORDINATES, OFFSET, NAME } entry per stop, where OFFSET is minutes after the bus
// leaves the Student Union. POLYLINE_STOPS and its "ghost" stops are unused here:
// they aren't boardable, and don't correspond to ROUTES.
import type { LatLng } from './geo';

export type LngLat = [number, number];

export interface Stop extends LatLng {
  id: string;
  key: string;
  routeId: string;
  name: string;
  offset: number;
  /** Position in the route's stops; leg `index` runs from this stop to the next. */
  index: number;
  /** The Student Union again at the end of the loop: you can get off but not board. */
  isReturn: boolean;
}

export interface Route {
  id: string;
  name: string;
  color: string;
  /** Real stops in travel order, ending with the return to the Student Union. */
  stops: Stop[];
  legs: LngLat[][];
  duration: number;
}

export interface Network {
  routes: Route[];
  routeById: Map<string, Route>;
  /** Where people wait: each route's stops, with the return stop folded into the first. */
  boardingStops: Stop[];
  stopById: Map<string, Stop>;
}

interface RawStop {
  COORDINATES: [number, number];
  OFFSET: number;
  NAME: string;
}
export type RawRoutes = Record<string, Record<string, unknown>>;

// Chosen for legibility on a light map. The API's pure #FF0000 / #0000FF are the
// fallback for any route added later.
const ROUTE_COLORS: Record<string, string> = { NORTH: '#d6322c', WEST: '#1f6feb' };

const titleCase = (id: string) => id.charAt(0) + id.slice(1).toLowerCase();

function isHidden(color: unknown): boolean {
  return typeof color !== 'string' || (color.length === 9 && color.endsWith('00'));
}

export function buildNetwork(raw: RawRoutes): Network {
  const routes: Route[] = [];
  for (const [id, r] of Object.entries(raw)) {
    // ENTRY/EXIT routes are transparent deadhead runs to and from the garage.
    if (isHidden(r.COLOR)) continue;
    const stopKeys = (r.STOPS as string[]) ?? [];
    const legsRaw = (r.ROUTES as [number, number][][]) ?? [];
    const stops: Stop[] = stopKeys.map((key, i) => {
      const s = r[key] as RawStop;
      return {
        id: `${id}:${key}`,
        key,
        routeId: id,
        name: s.NAME.replace(/\s*\(Return\)$/, ''),
        lat: s.COORDINATES[0],
        lng: s.COORDINATES[1],
        offset: s.OFFSET,
        index: i,
        isReturn: i === stopKeys.length - 1 && key.endsWith('_RETURN'),
      };
    });
    const legs = legsRaw.map((leg) => leg.map(([lat, lng]): LngLat => [lng, lat]));
    routes.push({
      id,
      name: `${titleCase(id)} Route`,
      color: ROUTE_COLORS[id] ?? (r.COLOR as string),
      stops,
      legs,
      duration: stops.at(-1)?.offset ?? 0,
    });
  }
  const boardingStops = routes.flatMap((r) => r.stops.filter((s) => !s.isReturn));
  return {
    routes,
    routeById: new Map(routes.map((r) => [r.id, r])),
    boardingStops,
    stopById: new Map(routes.flatMap((r) => r.stops).map((s) => [s.id, s])),
  };
}

/** The road path a bus follows between two stops on the same route. */
export function pathBetween(route: Route, from: Stop, to: Stop): LngLat[] {
  return route.legs.slice(from.index, to.index).flat();
}

export function stopsBetween(route: Route, from: Stop, to: Stop): Stop[] {
  return route.stops.filter((s) => s.index > from.index && s.index < to.index);
}
