import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, Map as MLMap, Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { minimalStyle } from '../lib/basemap';
import type { LatLng } from '../lib/geo';
import { busStatusText, type Bus } from '../lib/live';
import type { CdtaOverview, CdtaVehicle } from '../lib/cdta';
import type { LngLat, Network } from '../lib/network';
import type { Place, RawPlace } from '../lib/search';

export interface TripOverlay {
  walks: LngLat[][];
  rides: { color: string; path: LngLat[] }[];
  stops: (LatLng & { name: string; color: string })[];
}

/** One CDTA route drawn in its own color, with its stops. */
export interface CdtaFocus {
  color: string;
  paths: LngLat[][];
  stops: (LatLng & { id: string; name: string })[];
}

export type MapPick =
  | { type: 'stop'; stopId: string }
  | { type: 'cdtaStop'; stopId: string }
  | { type: 'place'; place: RawPlace }
  | { type: 'point'; point: LatLng };

export interface MapHandle {
  fitTo(points: LngLat[], maxZoom?: number): void;
}

interface Props {
  network: Network | null;
  labelledPlaces: RawPlace[];
  buses: Bus[];
  pin: Place | null;
  origin: Place | null;
  me: LatLng | null;
  browse: Place[] | null;
  trip: TripOverlay | null;
  /** Show only this route at full strength. */
  focusRouteId: string | null;
  selectedStopId: string | null;
  selectedBusId: string | null;
  satellite: boolean;
  /** Fade everything except the selected route or trip. */
  focus: boolean;
  cdta: CdtaOverview | null;
  showCdta: boolean;
  cdtaVehicles: CdtaVehicle[];
  cdtaFocus: CdtaFocus | null;
  selectedCdtaStopId: string | null;
  onPick(pick: MapPick): void;
  onBusClick(id: string): void;
  onReady(): void;
}

// MapLibre 6 ships its worker as a separate module, and bundling hides where it is.
maplibregl.setWorkerUrl(workerUrl);

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const SATELLITE_TILES = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}';
const INITIAL_CENTER: LngLat = [-73.6775, 42.7305];
const FONT_REGULAR = ['Noto Sans Regular'];
const PICKABLE = ['stops-circle', 'stops-label', 'cdta-focus-stops', 'cdta-focus-stops-label', 'cdta-stops', 'cdta-stops-label', 'places-label', 'browse-dot', 'browse-label'];
const CDTA_LAYERS = ['cdta-stops', 'cdta-stops-label', 'cdta-stops-selected'];
/**
 * How much the map behind a selected route or trip fades. Enough for the route to stand
 * out, not so much that you lose the streets you're trying to find your way along.
 */
const FOCUS_WASH_MAP = 0.38;
const FOCUS_WASH_SATELLITE = 0.12;
/** NY State's aerial photos are far sharper than USGS's, but slower, so they're for close up. */
const NY_IMAGERY_MIN_ZOOM = 15;
const NY_IMAGERY_TILES =
  'https://orthos.its.ny.gov/arcgis/rest/services/wms/Latest/MapServer/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=512,512&format=jpg&f=image';
/** Bus numbers appear from this zoom. */
const NEAR_ZOOM = 14.5;
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
/** A position update animates over about one polling interval. */
const BUS_GLIDE_MS = 4_500;
/** A bigger jump than this is a GPS correction or a gap in data: don't animate across town. */
const BUS_SNAP_METERS_DEG = 0.004;

function arrowImage(color: string): ImageData {
  const size = 48;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.beginPath();
  ctx.moveTo(38, 24);
  ctx.lineTo(13, 10);
  ctx.lineTo(19, 24);
  ctx.lineTo(13, 38);
  ctx.closePath();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 7;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fill();
  return ctx.getImageData(0, 0, size, size);
}

function ensureArrow(map: MLMap, color: string) {
  const image = `route-arrow-${color}`;
  if (!map.hasImage(image)) map.addImage(image, arrowImage(color), { pixelRatio: 2 });
}

function pinElement(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'map-pin';
  el.innerHTML =
    '<svg viewBox="0 0 28 38" width="26" height="35" aria-hidden="true"><path d="M14 1C6.8 1 1 6.8 1 14c0 9.8 13 23 13 23s13-13.2 13-23C27 6.8 21.2 1 14 1z" fill="#1b1c1e" stroke="#fff" stroke-width="2"/><circle cx="14" cy="14" r="4.2" fill="#fff"/></svg>';
  return el;
}

function dotElement(className: string): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

function busElement(kind: MarkerSpec['kind'], onClick: () => void): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  if (kind === 'shuttle') {
    el.className = 'bus-marker';
    el.innerHTML = '<span class="bus-arrow"></span><span class="bus-body"></span><span class="bus-tag"></span>';
  } else {
    el.className = 'cdta-marker';
    el.innerHTML = '<span class="bus-arrow"></span><span class="cdta-body"></span>';
  }
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return el;
}

interface MarkerSpec {
  id: string;
  kind: 'shuttle' | 'cdta';
  label: string;
  title: string;
  color: string;
  textColor: string;
  lat: number;
  lng: number;
  heading: number | null;
  stale: boolean;
}

interface BusMarker {
  marker: Marker;
  el: HTMLButtonElement;
  from: LngLat;
  to: LngLat;
  startedAt: number;
}

export const MapView = forwardRef<MapHandle, Props>(function MapView(props, ref) {
  const { network, labelledPlaces, buses, pin, origin, me, browse, trip, focusRouteId, selectedStopId, selectedBusId, satellite, focus, cdta, showCdta, cdtaVehicles, cdtaFocus, selectedCdtaStopId } = props;
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const [ready, setReady] = useState(false);
  const callbacks = useRef({ onPick: props.onPick, onBusClick: props.onBusClick, onReady: props.onReady });
  callbacks.current = { onPick: props.onPick, onBusClick: props.onBusClick, onReady: props.onReady };

  useImperativeHandle(ref, () => ({
    fitTo(points, maxZoom = 16.5) {
      const map = mapRef.current;
      if (!map || !points.length) return;
      const bounds = points.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(points[0], points[0]));
      map.fitBounds(bounds, { padding: currentPadding(), maxZoom, duration: reducedMotion() ? 0 : 700 });
    },
  }), []);

  // --- Map creation -------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    let map: MLMap | null = null;
    const create = (style: string | maplibregl.StyleSpecification) => {
      if (cancelled) return;
      map = new maplibregl.Map({
        container: container.current!,
        style,
        center: INITIAL_CENTER,
        zoom: 14,
        attributionControl: { compact: false, customAttribution: 'Bus data from CDTA' },
        dragRotate: false,
        pitchWithRotate: false,
        maxPitch: 0,
      });
      const created = map;
      created.touchZoomRotate.disableRotation();
      created.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
      mapRef.current = created;

      const updateNear = () => container.current?.classList.toggle('is-near', created.getZoom() >= NEAR_ZOOM);
      created.on('zoom', updateNear);
      updateNear();

      created.on('load', () => {
        addOverlayLayers(created);
        setReady(true);
        callbacks.current.onReady();
      });

      created.on('click', (e) => {
        const { x, y } = e.point;
        const box: [[number, number], [number, number]] = [[x - 8, y - 8], [x + 8, y + 8]];
        const hit = created.queryRenderedFeatures(box, { layers: PICKABLE.filter((l) => created.getLayer(l)) })[0];
        if (hit?.properties?.cdtaStopId) callbacks.current.onPick({ type: 'cdtaStop', stopId: hit.properties.cdtaStopId });
        else if (hit?.properties?.stopId) callbacks.current.onPick({ type: 'stop', stopId: hit.properties.stopId });
        else if (hit?.properties?.placeJson) callbacks.current.onPick({ type: 'place', place: JSON.parse(hit.properties.placeJson) });
        else callbacks.current.onPick({ type: 'point', point: { lat: e.lngLat.lat, lng: e.lngLat.lng } });
      });

      for (const layer of PICKABLE) {
        created.on('mouseenter', layer, () => (created.getCanvas().style.cursor = 'pointer'));
        created.on('mouseleave', layer, () => (created.getCanvas().style.cursor = ''));
      }
    };

    // Restyled before the first paint, so the colorful default never flashes.
    fetch(STYLE_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        return res.json();
      })
      .then((style) => create(minimalStyle(style)), () => create(STYLE_URL));

    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
    };
  }, []);

  // --- Data sources ---------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !network) return;
    for (const r of network.routes) ensureArrow(map, r.color);
    source(map, 'routes').setData({
      type: 'FeatureCollection',
      features: network.routes.map((r) => ({
        type: 'Feature',
        properties: { routeId: r.id, color: r.color },
        geometry: { type: 'LineString', coordinates: r.legs.flat() },
      })),
    });
    source(map, 'stops').setData({
      type: 'FeatureCollection',
      features: network.boardingStops.map((s) => ({
        type: 'Feature',
        properties: { stopId: s.id, routeId: s.routeId, name: s.name, color: network.routeById.get(s.routeId)!.color },
        geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
      })),
    });
  }, [ready, network]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    source(map, 'places').setData({
      type: 'FeatureCollection',
      features: labelledPlaces.map((p) => ({
        type: 'Feature',
        properties: { name: shortLabel(p.name), placeJson: JSON.stringify(p) },
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      })),
    });
  }, [ready, labelledPlaces]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    source(map, 'browse').setData(
      browse
        ? {
            type: 'FeatureCollection',
            features: browse.map((p) => ({
              type: 'Feature',
              properties: {
                name: p.name,
                placeJson: JSON.stringify({ name: p.name, lat: p.lat, lng: p.lng, cat: p.cat, campus: p.kind === 'campus', addr: p.subtitle }),
              },
              geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
            })),
          }
        : EMPTY,
    );
    map.setLayoutProperty('places-label', 'visibility', browse ? 'none' : 'visible');
  }, [ready, browse]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    for (const r of trip?.rides ?? []) ensureArrow(map, r.color);
    source(map, 'trip-walk').setData({
      type: 'FeatureCollection',
      features: (trip?.walks ?? []).map((coords) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } })),
    });
    source(map, 'trip-ride').setData({
      type: 'FeatureCollection',
      features: (trip?.rides ?? []).map((r) => ({ type: 'Feature', properties: { color: r.color }, geometry: { type: 'LineString', coordinates: r.path } })),
    });
    source(map, 'trip-stops').setData({
      type: 'FeatureCollection',
      features: (trip?.stops ?? []).map((s) => ({
        type: 'Feature',
        properties: { name: s.name, color: s.color },
        geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
      })),
    });
  }, [ready, trip]);

  // --- CDTA ----------------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !cdta) return;
    source(map, 'cdta-stops').setData({
      type: 'FeatureCollection',
      features: cdta.stops.map((s) => ({ type: 'Feature', properties: { cdtaStopId: s.id, name: s.name }, geometry: { type: 'Point', coordinates: [s.lng, s.lat] } })),
    });
  }, [ready, cdta]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    for (const layer of CDTA_LAYERS) map.setLayoutProperty(layer, 'visibility', showCdta && !focus ? 'visible' : 'none');
  }, [ready, showCdta, focus]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    map.setFilter('cdta-stops-selected', ['==', ['get', 'cdtaStopId'], selectedCdtaStopId ?? '']);
  }, [ready, selectedCdtaStopId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    if (cdtaFocus) ensureArrow(map, cdtaFocus.color);
    source(map, 'cdta-focus').setData({
      type: 'FeatureCollection',
      features: (cdtaFocus?.paths ?? []).map((coords) => ({ type: 'Feature', properties: { color: cdtaFocus!.color }, geometry: { type: 'LineString', coordinates: coords } })),
    });
    source(map, 'cdta-focus-stops').setData({
      type: 'FeatureCollection',
      features: (cdtaFocus?.stops ?? []).map((s) => ({
        type: 'Feature',
        properties: { cdtaStopId: s.id, name: s.name, color: cdtaFocus!.color },
        geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
      })),
    });
  }, [ready, cdtaFocus]);

  // --- Focus: a selected route or trip is the only thing left at full strength -----------
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    map.setPaintProperty('focus-wash', 'background-opacity', focus ? (satellite ? FOCUS_WASH_SATELLITE : FOCUS_WASH_MAP) : 0);
    // Filters rather than opacity, so hidden routes and stops can't be clicked by accident.
    const noShuttles = trip || cdtaFocus;
    const routeFilter: maplibregl.FilterSpecification | null = noShuttles
      ? ['==', ['get', 'routeId'], '']
      : focusRouteId
        ? ['==', ['get', 'routeId'], focusRouteId]
        : null;
    for (const layer of ['routes-casing', 'routes-line', 'routes-arrows', 'stops-circle', 'stops-label']) map.setFilter(layer, routeFilter);
    map.setPaintProperty('routes-line', 'line-width', focusRouteId ? ROUTE_WIDTH_FOCUSED : ROUTE_WIDTH);
    map.setPaintProperty('routes-casing', 'line-width', focusRouteId ? ROUTE_CASING_FOCUSED : ROUTE_CASING);
    map.setFilter('stops-selected', ['==', ['get', 'stopId'], selectedStopId ?? '']);
    container.current?.classList.toggle('cdta-focus-on', Boolean(cdtaFocus));
  }, [ready, focus, satellite, trip, focusRouteId, selectedStopId, cdtaFocus]);

  // --- Satellite ---------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    map.setLayoutProperty('satellite', 'visibility', satellite ? 'visible' : 'none');
    map.setLayoutProperty('satellite-ny', 'visibility', satellite ? 'visible' : 'none');
    // Grey text disappears on photos: light text with a dark edge reads on anything.
    for (const layer of map.getStyle().layers ?? []) {
      if (layer.type !== 'symbol' || !(/^(highway-name|label_|places-label)/.test(layer.id))) continue;
      map.setPaintProperty(layer.id, 'text-color', satellite ? '#ffffff' : layer.id === 'places-label' ? PLACE_LABEL_COLOR : BASE_LABEL_COLOR);
      map.setPaintProperty(layer.id, 'text-halo-color', satellite ? 'rgba(0,0,0,0.75)' : '#ffffff');
    }
    container.current?.classList.toggle('is-satellite', satellite);
  }, [ready, satellite]);

  // --- Pins ---------------------------------------------------------------------------
  useSimpleMarker(mapRef, ready, pin, pinElement, 'bottom');
  useSimpleMarker(mapRef, ready, origin, () => dotElement('map-origin'), 'center');
  useSimpleMarker(mapRef, ready, me, () => dotElement('map-me'), 'center');

  // --- Live buses ----------------------------------------------------------------------
  const busMarkers = useRef(new Map<string, BusMarker>());

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const specs: MarkerSpec[] = [
      ...cdtaVehicles.map((v): MarkerSpec => ({
        id: `cdta:${v.id}`,
        kind: 'cdta',
        label: v.short,
        title: `CDTA route ${v.short}, bus ${v.id}. ${v.headsign}`,
        color: v.color,
        textColor: v.textColor,
        lat: v.lat,
        lng: v.lng,
        heading: v.heading ?? null,
        stale: v.ageSeconds > 180,
      })),
      ...buses.map((bus): MarkerSpec => ({
        id: bus.id,
        kind: 'shuttle',
        label: bus.name,
        title: `Bus ${bus.name}, ${bus.route?.name ?? 'not on a route'}. ${busStatusText(bus)}`,
        color: bus.route?.color ?? '#5f6672',
        textColor: '#ffffff',
        lat: bus.lat,
        lng: bus.lng,
        heading: bus.heading,
        stale: bus.stale,
      })),
    ];
    const markers = busMarkers.current;
    const seen = new Set<string>();
    const now = performance.now();
    for (const spec of specs) {
      seen.add(spec.id);
      const position: LngLat = [spec.lng, spec.lat];
      let entry = markers.get(spec.id);
      if (!entry) {
        const el = busElement(spec.kind, () => callbacks.current.onBusClick(spec.id));
        const marker = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(position).addTo(map);
        entry = { marker, el, from: position, to: position, startedAt: now };
        markers.set(spec.id, entry);
      } else if (position[0] !== entry.to[0] || position[1] !== entry.to[1]) {
        const shown = entry.marker.getLngLat();
        const jump = Math.hypot(position[0] - shown.lng, position[1] - shown.lat);
        const snap = reducedMotion() || jump > BUS_SNAP_METERS_DEG;
        entry.from = snap ? position : [shown.lng, shown.lat];
        entry.to = position;
        entry.startedAt = now;
        if (snap) entry.marker.setLngLat(position);
      }
      const { el } = entry;
      el.style.setProperty('--bus-color', spec.color);
      el.style.setProperty('--bus-text', spec.textColor);
      el.classList.toggle('is-stale', spec.stale);
      el.classList.toggle('is-selected', spec.id === selectedBusId);
      el.classList.toggle('is-moving', spec.heading != null);
      el.dataset.bus = spec.label;
      const arrow = el.querySelector<HTMLElement>('.bus-arrow')!;
      if (spec.heading != null) arrow.style.transform = `rotate(${spec.heading}deg)`;
      const text = el.querySelector(spec.kind === 'cdta' ? '.cdta-body' : '.bus-tag')!;
      if (text.textContent !== spec.label) text.textContent = spec.label;
      el.setAttribute('aria-label', spec.title);
      el.title = spec.title;
    }
    for (const [id, entry] of markers) {
      if (!seen.has(id)) {
        entry.marker.remove();
        markers.delete(id);
      }
    }
  }, [ready, buses, cdtaVehicles, selectedBusId]);

  useEffect(() => {
    if (!ready) return;
    let frame = 0;
    const tick = () => {
      const now = performance.now();
      for (const entry of busMarkers.current.values()) {
        const t = Math.min(1, (now - entry.startedAt) / BUS_GLIDE_MS);
        if (t < 1) {
          entry.marker.setLngLat([
            entry.from[0] + (entry.to[0] - entry.from[0]) * t,
            entry.from[1] + (entry.to[1] - entry.from[1]) * t,
          ]);
        } else if (entry.from !== entry.to) {
          entry.marker.setLngLat(entry.to);
          entry.from = entry.to;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [ready]);

  return <div ref={container} className="map" role="application" aria-label="Map of the RPI shuttle routes" />;
});

function useSimpleMarker(
  mapRef: React.RefObject<MLMap | null>,
  ready: boolean,
  point: LatLng | null,
  create: () => HTMLElement,
  anchor: 'center' | 'bottom',
) {
  const lat = point?.lat;
  const lng = point?.lng;
  const createRef = useRef(create);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || lat == null || lng == null) return;
    const marker = new maplibregl.Marker({ element: createRef.current(), anchor }).setLngLat([lng, lat]).addTo(map);
    return () => void marker.remove();
  }, [mapRef, ready, lat, lng, anchor]);
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const source = (map: MLMap, id: string) => map.getSource(id) as GeoJSONSource;

/** Keeps fitted content clear of whichever panel is covering the map. */
function currentPadding() {
  const base = 56;
  const panel = document.querySelector('.panel');
  const search = document.querySelector('.search-area');
  const mobile = window.matchMedia('(max-width: 760px)').matches;
  if (mobile) {
    const top = (search?.getBoundingClientRect().bottom ?? 0) + 28;
    const sheetTop = panel?.getBoundingClientRect().top ?? window.innerHeight;
    return { top, bottom: Math.max(36, window.innerHeight - sheetTop + 28), left: 36, right: 36 };
  }
  const right = panel?.getBoundingClientRect().right ?? 0;
  return { top: base, bottom: base, left: right + base, right: base + 24 };
}

function shortLabel(name: string): string {
  return name
    .replace(/^Experimental Media and Performing Arts Center \(EMPAC\)$/, 'EMPAC')
    .replace(/^Center for Biotechnology and Interdisciplinary Studies$/, 'CBIS')
    .replace(/^East Campus Athletic Village Arena & Stadium$/, 'ECAV Arena & Stadium')
    .replace(/^RPI International Services for Students and Scholars \(ISSS\)$/, 'ISSS')
    .replace(/^J Erik Jonsson Engineering Center$/, 'Jonsson Engineering Center')
    .replace(/^Low Center For Industrial Innovation$/, 'Low Center')
    .replace(/^Rensselaer Student Union$/, 'Student Union')
    .replace(/\s*\(RPI\)$/, '');
}

const ROUTE_WIDTH: maplibregl.ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 12, 2, 16, 4.5, 19, 8];
const ROUTE_CASING: maplibregl.ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 12, 3.5, 16, 7, 19, 11];
const ROUTE_WIDTH_FOCUSED: maplibregl.ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 11, 4, 14, 6, 16, 8, 19, 13];
const ROUTE_CASING_FOCUSED: maplibregl.ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 11, 7, 14, 10, 16, 13, 19, 19];
const TEXT_DARK = '#2b2d30';
const BASE_LABEL_COLOR = '#55595e';
const PLACE_LABEL_COLOR = '#6b6f74';

function addOverlayLayers(map: MLMap) {
  for (const id of ['routes', 'stops', 'places', 'browse', 'trip-walk', 'trip-ride', 'trip-stops', 'cdta-stops', 'cdta-focus', 'cdta-focus-stops']) {
    map.addSource(id, { type: 'geojson', data: EMPTY });
  }

  const firstLabel = map.getStyle().layers?.find((l) => l.type === 'symbol' && l.layout?.['text-field'] && /highway|transport/.test(l.id))?.id;
  map.addSource('satellite', {
    type: 'raster',
    tiles: [SATELLITE_TILES],
    tileSize: 256,
    maxzoom: 16,
    attribution: 'Imagery © <a href="https://www.usgs.gov/" target="_blank" rel="noreferrer">USGS</a>',
  });
  map.addLayer({ id: 'satellite', type: 'raster', source: 'satellite', layout: { visibility: 'none' } }, firstLabel);
  map.addSource('satellite-ny', {
    type: 'raster',
    tiles: [NY_IMAGERY_TILES],
    tileSize: 256,
    minzoom: NY_IMAGERY_MIN_ZOOM,
    maxzoom: 19,
    attribution: 'Imagery © <a href="https://gis.ny.gov/" target="_blank" rel="noreferrer">NYS ITS</a>',
  });
  map.addLayer(
    { id: 'satellite-ny', type: 'raster', source: 'satellite-ny', minzoom: NY_IMAGERY_MIN_ZOOM, layout: { visibility: 'none' }, paint: { 'raster-fade-duration': 150 } },
    firstLabel,
  );

  // Over the map's streets and buildings, but under its labels, so names stay readable.
  map.addLayer({ id: 'focus-wash', type: 'background', paint: { 'background-color': '#ffffff', 'background-opacity': 0 } }, firstLabel);

  // Drive on the right: nudging each line to its own side separates routes sharing a street.
  const lineOffset: maplibregl.ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 13, 0.5, 16, 2.5, 19, 6];
  map.addLayer({
    id: 'routes-casing',
    type: 'line',
    source: 'routes',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': ROUTE_CASING, 'line-offset': lineOffset },
  });
  map.addLayer({
    id: 'routes-line',
    type: 'line',
    source: 'routes',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': ROUTE_WIDTH, 'line-offset': lineOffset },
  });

  // Every loop is one-way, so direction matters as much as the line itself.
  const arrowLayout = (spacing: maplibregl.ExpressionSpecification): maplibregl.SymbolLayerSpecification['layout'] => ({
    'symbol-placement': 'line',
    'symbol-spacing': spacing,
    'icon-image': ['concat', 'route-arrow-', ['get', 'color']],
    'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.45, 16, 0.75, 19, 1.1],
    'icon-offset': [0, 3],
    'icon-rotation-alignment': 'map',
    'icon-allow-overlap': true,
    'icon-ignore-placement': true,
  });
  const sparseArrows: maplibregl.ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 13, 100, 16, 170, 19, 240];
  map.addLayer({ id: 'routes-arrows', type: 'symbol', source: 'routes', minzoom: 12.5, layout: arrowLayout(sparseArrows) });

  // A selected CDTA route: thick, in its own color.
  map.addLayer({
    id: 'cdta-focus-casing',
    type: 'line',
    source: 'cdta-focus',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': ROUTE_CASING_FOCUSED },
  });
  map.addLayer({
    id: 'cdta-focus-line',
    type: 'line',
    source: 'cdta-focus',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': ROUTE_WIDTH_FOCUSED },
  });
  map.addLayer({
    id: 'cdta-focus-arrows',
    type: 'symbol',
    source: 'cdta-focus',
    layout: { ...arrowLayout(sparseArrows), 'icon-offset': [0, 0], 'icon-size': ['interpolate', ['linear'], ['zoom'], 11, 0.6, 16, 0.9, 19, 1.2] },
  });

  // A selected trip.
  map.addLayer({
    id: 'trip-ride-casing',
    type: 'line',
    source: 'trip-ride',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': ROUTE_CASING_FOCUSED },
  });
  map.addLayer({
    id: 'trip-ride',
    type: 'line',
    source: 'trip-ride',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': ROUTE_WIDTH_FOCUSED },
  });
  map.addLayer({
    id: 'trip-ride-arrows',
    type: 'symbol',
    source: 'trip-ride',
    layout: { ...arrowLayout(sparseArrows), 'icon-offset': [0, 0], 'icon-size': ['interpolate', ['linear'], ['zoom'], 11, 0.6, 16, 0.9, 19, 1.2] },
  });
  map.addLayer({
    id: 'trip-walk',
    type: 'line',
    source: 'trip-walk',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': TEXT_DARK, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 3, 16, 4.5, 19, 7], 'line-dasharray': [0.1, 2] },
  });

  // Campus building names: quiet, and the first to give way to anything else.
  map.addLayer({
    id: 'places-label',
    type: 'symbol',
    source: 'places',
    minzoom: 15.5,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': FONT_REGULAR,
      'text-size': ['interpolate', ['linear'], ['zoom'], 15.5, 10.5, 18, 13],
      'text-max-width': 8,
    },
    paint: { 'text-color': PLACE_LABEL_COLOR, 'text-halo-color': '#ffffff', 'text-halo-width': 1.2 },
  });

  map.addLayer({
    id: 'browse-dot',
    type: 'circle',
    source: 'browse',
    paint: { 'circle-radius': 4, 'circle-color': TEXT_DARK, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5 },
  });
  map.addLayer({
    id: 'browse-label',
    type: 'symbol',
    source: 'browse',
    minzoom: 14.5,
    layout: { 'text-field': ['get', 'name'], 'text-font': FONT_REGULAR, 'text-size': 11.5, 'text-max-width': 9, 'text-anchor': 'top', 'text-offset': [0, 0.5] },
    paint: { 'text-color': TEXT_DARK, 'text-halo-color': '#ffffff', 'text-halo-width': 1.4 },
  });

  // CDTA stops: only once you're close enough to be choosing one.
  map.addLayer({
    id: 'cdta-stops-selected',
    type: 'circle',
    source: 'cdta-stops',
    filter: ['==', ['get', 'cdtaStopId'], ''],
    paint: { 'circle-radius': 9, 'circle-color': '#ffffff', 'circle-stroke-color': TEXT_DARK, 'circle-stroke-width': 3 },
  });
  map.addLayer({
    id: 'cdta-stops',
    type: 'circle',
    source: 'cdta-stops',
    minzoom: 15,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 15, 2, 18, 4.5],
      'circle-color': '#ffffff',
      'circle-stroke-color': '#8d9096',
      'circle-stroke-width': 1.2,
    },
  });
  map.addLayer({
    id: 'cdta-stops-label',
    type: 'symbol',
    source: 'cdta-stops',
    minzoom: 16.8,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': FONT_REGULAR,
      'text-size': 10.5,
      'text-max-width': 8,
      'text-variable-anchor': ['top', 'bottom', 'left', 'right'],
      'text-radial-offset': 0.7,
    },
    paint: { 'text-color': '#7c8086', 'text-halo-color': '#ffffff', 'text-halo-width': 1.2 },
  });

  // Shuttle stops.
  map.addLayer({
    id: 'stops-selected',
    type: 'circle',
    source: 'stops',
    filter: ['==', ['get', 'stopId'], ''],
    paint: { 'circle-radius': 12, 'circle-color': ['get', 'color'], 'circle-opacity': 0.22 },
  });
  map.addLayer({
    id: 'stops-circle',
    type: 'circle',
    source: 'stops',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 2.5, 15, 4.5, 18, 7],
      'circle-color': '#ffffff',
      'circle-stroke-color': ['get', 'color'],
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 12, 1.5, 15, 2.5, 18, 3],
    },
  });
  map.addLayer({
    id: 'stops-label',
    type: 'symbol',
    source: 'stops',
    minzoom: 13.2,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': FONT_REGULAR,
      'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10.5, 16, 12.5, 18, 14],
      'text-max-width': 9,
      'text-variable-anchor': ['left', 'right', 'top', 'bottom'],
      'text-radial-offset': 0.7,
      'text-justify': 'auto',
    },
    paint: { 'text-color': TEXT_DARK, 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
  });

  map.addLayer({
    id: 'cdta-focus-stops',
    type: 'circle',
    source: 'cdta-focus-stops',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2, 14, 3.5, 18, 7],
      'circle-color': '#ffffff',
      'circle-stroke-color': ['get', 'color'],
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 14, 2, 18, 3],
    },
  });
  map.addLayer({
    id: 'cdta-focus-stops-label',
    type: 'symbol',
    source: 'cdta-focus-stops',
    minzoom: 13.8,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': FONT_REGULAR,
      'text-size': 11,
      'text-max-width': 9,
      'text-variable-anchor': ['left', 'right', 'top', 'bottom'],
      'text-radial-offset': 0.7,
    },
    paint: { 'text-color': TEXT_DARK, 'text-halo-color': '#ffffff', 'text-halo-width': 1.6 },
  });

  map.addLayer({
    id: 'trip-stops',
    type: 'circle',
    source: 'trip-stops',
    paint: { 'circle-radius': 6, 'circle-color': '#ffffff', 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 3 },
  });
  map.addLayer({
    id: 'trip-stops-label',
    type: 'symbol',
    source: 'trip-stops',
    layout: {
      'text-field': ['get', 'name'],
      'text-font': FONT_REGULAR,
      'text-size': 12,
      'text-max-width': 11,
      'text-variable-anchor': ['left', 'right', 'top', 'bottom'],
      'text-radial-offset': 0.9,
    },
    paint: { 'text-color': TEXT_DARK, 'text-halo-color': '#ffffff', 'text-halo-width': 1.8 },
  });
}
