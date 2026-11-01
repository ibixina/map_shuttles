// Search has two tiers: an instant local index (stops + campus buildings, including
// abbreviations like "DCC" that general geocoders don't know), then Photon for
// addresses and businesses anywhere around Troy.
import { CAMPUS, type LatLng } from './geo';
import type { CdtaOverview, CdtaRoute, CdtaStop } from './cdta';
import type { Network, Stop } from './network';

export type PlaceCategory = 'academic' | 'food' | 'housing' | 'parking' | 'athletics' | 'other';

export interface RawPlace extends LatLng {
  name: string;
  cat: PlaceCategory;
  campus: boolean;
  addr?: string;
  aliases?: string[];
  label?: boolean;
}

export type PlaceKind = 'stop' | 'campus' | 'poi' | 'address' | 'pin' | 'me' | 'cdta-stop' | 'cdta-route';

export interface Place extends LatLng {
  id: string;
  name: string;
  subtitle?: string;
  kind: PlaceKind;
  stopId?: string;
  cdtaStopId?: string;
  cdtaRouteId?: string;
  cat?: PlaceCategory;
}

interface IndexEntry {
  place: Place;
  norm: string;
  words: string[];
  aliases: string[];
  boost: number;
}

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Edit distance with adjacent swaps counted as one edit ("feild" for "field"). */
function withinEdits(a: string, b: string, limit: number): boolean {
  if (Math.abs(a.length - b.length) > limit) return false;
  let beforePrevious: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        row[j] = Math.min(row[j], beforePrevious[j - 2] + 1);
      }
      best = Math.min(best, row[j]);
    }
    // A swap can still lower the next row by one, so allow for that before giving up.
    if (best > limit + 1) return false;
    beforePrevious = previous;
    previous = row;
  }
  return previous[b.length] <= limit;
}

function matchScore(entry: IndexEntry, query: string, tokens: string[]): number {
  if (entry.norm === query) return 100;
  if (entry.aliases.includes(query)) return 96;
  if (entry.aliases.some((a) => a.startsWith(query))) return 82;
  if (entry.norm.startsWith(query)) return 80;
  if (entry.words.some((w) => w.startsWith(query))) return 72;
  if (tokens.every((t) => entry.words.some((w) => w.startsWith(t)))) return 66;
  if (tokens.every((t) => entry.norm.includes(t))) return 50;
  // Typos: every query word starts some word exactly, or is a close misspelling of one.
  const closeEnough = (t: string, w: string) => w.startsWith(t) || (t.length >= 4 && withinEdits(t, w, t.length >= 8 ? 2 : 1));
  if (tokens.every((t) => entry.words.some((w) => closeEnough(t, w)))) return 34;
  return 0;
}

const stopSubtitle = (stop: Stop, network: Network) => `${network.routeById.get(stop.routeId)?.name ?? stop.routeId} stop`;

export function stopToPlace(stop: Stop, network: Network): Place {
  return {
    id: `stop:${stop.id}`,
    name: stop.name,
    subtitle: stopSubtitle(stop, network),
    lat: stop.lat,
    lng: stop.lng,
    kind: 'stop',
    stopId: stop.id,
  };
}

export function cdtaStopToPlace(stop: CdtaStop): Place {
  return {
    id: `cdta-stop:${stop.id}`,
    name: stop.name,
    subtitle: `CDTA stop · ${stop.routes.slice(0, 6).join(', ')}`,
    lat: stop.lat,
    lng: stop.lng,
    kind: 'cdta-stop',
    cdtaStopId: stop.id,
  };
}

function cdtaRouteToPlace(route: CdtaRoute): Place {
  return { id: `cdta-route:${route.id}`, name: `CDTA ${route.short}`, subtitle: route.long, lat: 0, lng: 0, kind: 'cdta-route', cdtaRouteId: route.id };
}

export function rawToPlace(raw: RawPlace): Place {
  return {
    id: `osm:${raw.name}:${raw.lat}`,
    name: raw.name,
    subtitle: raw.addr ?? (raw.campus ? 'RPI campus' : 'Troy, NY'),
    lat: raw.lat,
    lng: raw.lng,
    kind: raw.campus ? 'campus' : 'poi',
    cat: raw.cat,
  };
}

export class LocalIndex {
  private readonly entries: IndexEntry[];

  constructor(places: RawPlace[], network: Network, cdta?: CdtaOverview | null) {
    const stopEntries: IndexEntry[] = network.boardingStops.map((stop) => {
      const norm = normalize(stop.name);
      return { place: stopToPlace(stop, network), norm, words: norm.split(' '), aliases: [normalize(stop.key)], boost: 8 };
    });
    const placeEntries: IndexEntry[] = places.map((raw) => {
      const norm = normalize(raw.name);
      return {
        place: rawToPlace(raw),
        norm,
        words: norm.split(' '),
        aliases: (raw.aliases ?? []).map(normalize),
        boost: raw.campus ? 5 : 0,
      };
    });
    const routeEntries: IndexEntry[] = (cdta?.routes ?? []).map((route) => {
      const norm = normalize(route.long);
      const number = normalize(route.short);
      return {
        place: cdtaRouteToPlace(route),
        norm,
        words: norm.split(' '),
        aliases: [number, `route ${number}`, `bus ${number}`, `cdta ${number}`],
        boost: 3,
      };
    });
    const cdtaStopEntries: IndexEntry[] = (cdta?.stops ?? []).map((stop) => {
      const norm = normalize(stop.name);
      return { place: cdtaStopToPlace(stop), norm, words: norm.split(' '), aliases: [normalize(stop.code)], boost: 1 };
    });
    this.entries = [...stopEntries, ...placeEntries, ...routeEntries, ...cdtaStopEntries];
  }

  search(rawQuery: string, limit = 8): Place[] {
    const query = normalize(rawQuery);
    if (!query) return [];
    const tokens = query.split(' ');
    const scored: { place: Place; score: number }[] = [];
    for (const entry of this.entries) {
      const base = matchScore(entry, query, tokens);
      if (base > 0) scored.push({ place: entry.place, score: base + entry.boost });
    }
    return scored
      .sort((a, b) => b.score - a.score || a.place.name.length - b.place.name.length)
      .slice(0, limit)
      .map((s) => s.place);
  }
}

// --- Photon (OpenStreetMap geocoder) -------------------------------------------------

const PHOTON = 'https://photon.komoot.io';
/** Roughly the Capital Region: anywhere further out isn't a shuttle question. */
const REGION_BBOX = '-74.05,42.50,-73.35,43.00';

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: Record<string, string | undefined>;
}

function photonToPlace(f: PhotonFeature): Place | null {
  const p = f.properties;
  const [lng, lat] = f.geometry.coordinates;
  const streetLine = [p.housenumber, p.street].filter(Boolean).join(' ');
  const name = p.name || streetLine;
  if (!name) return null;
  const area = [p.city ?? p.locality ?? p.county, p.state === 'New York' ? 'NY' : p.state].filter(Boolean).join(', ');
  const subtitle = [p.name ? streetLine : '', area].filter(Boolean).join(', ');
  return {
    id: `photon:${p.osm_type}${p.osm_id}`,
    name,
    subtitle,
    lat,
    lng,
    kind: p.name ? 'poi' : 'address',
  };
}

export async function searchPhoton(query: string, signal?: AbortSignal): Promise<Place[]> {
  const url = `${PHOTON}/api/?q=${encodeURIComponent(query)}&lat=${CAMPUS.lat}&lon=${CAMPUS.lng}&limit=8&lang=en&bbox=${REGION_BBOX}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Photon ${res.status}`);
  const json = (await res.json()) as { features: PhotonFeature[] };
  return json.features.map(photonToPlace).filter((p): p is Place => p !== null);
}

export async function reverseGeocode(point: LatLng, signal?: AbortSignal): Promise<Pick<Place, 'name' | 'subtitle'> | null> {
  const res = await fetch(`${PHOTON}/reverse?lat=${point.lat}&lon=${point.lng}&limit=1&lang=en`, { signal });
  if (!res.ok) return null;
  const json = (await res.json()) as { features: PhotonFeature[] };
  const place = json.features[0] ? photonToPlace(json.features[0]) : null;
  return place && { name: place.name, subtitle: place.subtitle };
}

/** Local results first; remote results fill in, minus any that duplicate a local one. */
export function mergeResults(local: Place[], remote: Place[], limit = 8): Place[] {
  const seen = new Set(local.map((p) => normalize(p.name)));
  const extra = remote.filter((p) => {
    const norm = normalize(p.name);
    if (seen.has(norm)) return false;
    seen.add(norm);
    return true;
  });
  return [...local.slice(0, Math.max(5, limit - extra.length)), ...extra].slice(0, limit);
}
