// Restyles the OpenFreeMap "Liberty" style into a quiet grey map, so the only strong
// colors on screen are the bus routes. Works on the style JSON, before anything draws.

const LAND = '#f1f1ee';
const GREEN = '#dfe8d8';
const WATER = '#c9d8e2';
const ROAD = '#ffffff';
const ROAD_EDGE = '#d6d6d2';
const BUILDING = '#e4e4df';
const LABEL = '#55595e';
const PLACE_LABEL = '#55595e';
const HALO = '#ffffff';

/** Icons, shields, patterns and boundaries: detail that competes with the routes. */
const HIDE = /^(natural_earth|park_outline|landuse_(residential|pitch|track|cemetery|hospital|school)|landcover_(ice|sand|wetland)|aeroway|road_area_pattern|.*hatching|boundary|road_one_way|poi_|highway-shield|road_shield|airport|building-3d|label_(country|state))/;

type Layer = {
  id: string;
  type: string;
  layout?: Record<string, unknown>;
  paint?: Record<string, unknown>;
};

function recolor(layer: Layer): Record<string, unknown> | null {
  const { id, type } = layer;
  if (type === 'background') return { 'background-color': LAND };
  if (type === 'fill') {
    if (id === 'water') return { 'fill-color': WATER, 'fill-opacity': 1 };
    if (id === 'building') return { 'fill-color': BUILDING, 'fill-outline-color': BUILDING, 'fill-opacity': 1 };
    if (/^(park|landcover)/.test(id)) return { 'fill-color': GREEN, 'fill-outline-color': GREEN, 'fill-opacity': 1 };
  }
  if (type === 'line') {
    if (/^waterway/.test(id)) return { 'line-color': WATER };
    if (/rail/.test(id)) return { 'line-color': ROAD_EDGE };
    if (/path_pedestrian/.test(id)) return { 'line-color': ROAD_EDGE };
    if (/casing/.test(id)) return { 'line-color': ROAD_EDGE };
    if (/^(road|bridge|tunnel)_/.test(id)) return { 'line-color': ROAD };
  }
  if (type === 'symbol') {
    if (/^(waterway|water_name)/.test(id)) return { 'text-color': '#8ba0ad', 'text-halo-color': HALO };
    if (/^highway-name/.test(id)) return { 'text-color': LABEL, 'text-halo-color': HALO };
    if (/^label_/.test(id)) return { 'text-color': PLACE_LABEL, 'text-halo-color': HALO };
  }
  return null;
}

export function minimalStyle<T extends { layers: unknown[] }>(style: T): T {
  const layers = (style.layers as Layer[]).map((layer) => {
    if (HIDE.test(layer.id)) return { ...layer, layout: { ...layer.layout, visibility: 'none' } };
    const paint = recolor(layer);
    return paint ? { ...layer, paint: { ...layer.paint, ...paint } } : layer;
  });
  return { ...style, layers };
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** Some CDTA routes are yellow, which vanishes on a pale map: darken those for drawing lines. */
export function lineColor(hex: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex) || luminance(hex) < 0.4) return hex;
  const darker = (i: number) => Math.round(parseInt(hex.slice(i, i + 2), 16) * 0.62).toString(16).padStart(2, '0');
  return `#${darker(1)}${darker(3)}${darker(5)}`;
}
