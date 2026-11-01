import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import rawPlaces from './data/places.json';
import { CdtaBusPanel, CdtaRoutePanel, CdtaRoutesPanel, CdtaStopPanel } from './components/cdtaPanels';
import { BackIcon, DirectionsIcon, SwapIcon } from './components/icons';
import { MapControls } from './components/parts';
import { MapView, type CdtaFocus, type MapHandle, type MapPick, type TripOverlay } from './components/MapView';
import { browsePlaces, BrowsePanel, BusPanel, DirectionsResults, RoutePanel, StopPanel, type LeaveAt } from './components/panels';
import { SearchBox, type QuickOption } from './components/SearchBox';
import { lineColor } from './lib/basemap';
import { fetchTransitTrips, nearestCdtaStops, useCdtaOverview, useCdtaVehicles, usePolled, type CdtaRouteDetail, type CdtaStopDetail, type CdtaVehicleDetail, type WalkTo } from './lib/cdta';
import { useClock, useShuttleData } from './lib/data';
import { callEngine, LIVE_URL } from './lib/engine';
import { CAMPUS, metersBetween, type LatLng } from './lib/geo';
import type { LngLat } from './lib/network';
import { estimateWalk, mergeTrips, planTrips, type PlanResult, type RideLeg, type WalkLeg } from './lib/planner';
import { cdtaStopToPlace, LocalIndex, rawToPlace, reverseGeocode, stopToPlace, type Place, type PlaceCategory, type RawPlace } from './lib/search';
import { DAY, formatTimeWithDay } from './lib/time';
import { fetchWalkPath, prepareWalkTimes, walkPathKey, walkTime, type WalkPath } from './lib/walking';

const PLACES = rawPlaces as RawPlace[];
const LABELLED = PLACES.filter((p) => p.label);
const ME_ID = 'me';
const CDTA_BUS_PREFIX = 'cdta:';
const CDTA_POLL_MS = 20_000;
const BROWSE: { cat: PlaceCategory; label: string }[] = [
  { cat: 'academic', label: 'Academic buildings' },
  { cat: 'food', label: 'Food' },
  { cat: 'housing', label: 'Housing' },
  { cat: 'athletics', label: 'Athletics' },
  { cat: 'parking', label: 'Parking' },
];
const CDTA_ROUTE_POLL_MS = 60_000;
/** A CDTA route counts as "near campus" with a stop this close. */
const NEAR_CAMPUS_METERS = 1_300;
/** Longest walk at either end of a trip worth asking the planner about. */
const MAX_WALK_LEG_METERS = 2_500;
const SHOW_CDTA_KEY = 'shuttle-map.show-cdta';

/** Trips start here until told otherwise: it's where both shuttle loops begin. */
const UNION_RAW = PLACES.find((p) => p.name === 'Rensselaer Student Union');
const UNION_PLACE: Place = UNION_RAW
  ? { ...rawToPlace(UNION_RAW), name: 'Student Union' }
  : { id: 'union', name: 'Student Union', lat: 42.7299, lng: -73.6766, kind: 'campus' };
/** Further than this from campus, your own location isn't a useful place to start from. */
const MAX_ORIGIN_METERS = 30_000;

function readShowCdta(): boolean {
  try {
    return localStorage.getItem(SHOW_CDTA_KEY) !== 'off';
  } catch {
    return true;
  }
}

type View =
  | { type: 'home' }
  | { type: 'stop'; stopId: string }
  | { type: 'route'; routeId: string }
  | { type: 'bus'; busId: string }
  | { type: 'browse'; cat: PlaceCategory; label: string }
  | { type: 'cdtaStop'; stopId: string }
  | { type: 'cdtaRoute'; routeId: string }
  | { type: 'cdtaBus'; vehicleId: string }
  | { type: 'cdtaRoutes' }
  | { type: 'directions'; from: Place | null; to: Place | null };

// --- URL state: so links can be shared and the back button works -----------------------

function encodePlace(p: Place): string {
  if (p.id === ME_ID) return 'me';
  return `${p.lat.toFixed(6)},${p.lng.toFixed(6)},${p.name}`;
}

function decodePlace(text: string | null): Place | null {
  if (!text) return null;
  const match = /^(-?[\d.]+),(-?[\d.]+),(.*)$/s.exec(text);
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { id: `url:${text}`, name: match[3] || 'Dropped pin', lat, lng, kind: 'pin' };
}

function viewToQuery(view: View): string {
  const q = new URLSearchParams();
  switch (view.type) {
    case 'stop': q.set('stop', view.stopId); break;
    case 'route': q.set('route', view.routeId); break;
    case 'bus': q.set('bus', view.busId); break;
    case 'browse': q.set('browse', view.cat); q.set('label', view.label); break;
    case 'cdtaStop': q.set('cstop', view.stopId); break;
    case 'cdtaRoute': q.set('croute', view.routeId); break;
    case 'cdtaBus': q.set('cbus', view.vehicleId); break;
    case 'cdtaRoutes': q.set('croutes', '1'); break;
    case 'directions':
      q.set('directions', '1');
      if (view.from) q.set('from', encodePlace(view.from));
      if (view.to) q.set('to', encodePlace(view.to));
      break;
  }
  const s = q.toString();
  return s ? `?${s}` : window.location.pathname;
}

function queryToView(): View {
  const q = new URLSearchParams(window.location.search);
  if (q.get('cstop')) return { type: 'cdtaStop', stopId: q.get('cstop')! };
  if (q.get('croute')) return { type: 'cdtaRoute', routeId: q.get('croute')! };
  if (q.get('cbus')) return { type: 'cdtaBus', vehicleId: q.get('cbus')! };
  if (q.get('croutes')) return { type: 'cdtaRoutes' };
  if (q.get('stop')) return { type: 'stop', stopId: q.get('stop')! };
  if (q.get('route')) return { type: 'route', routeId: q.get('route')! };
  if (q.get('bus')) return { type: 'bus', busId: q.get('bus')! };
  if (q.get('browse')) return { type: 'browse', cat: q.get('browse') as PlaceCategory, label: q.get('label') ?? 'Places' };
  if (q.get('directions')) return { type: 'directions', from: decodePlace(q.get('from')), to: decodePlace(q.get('to')) };
  const place = decodePlace(q.get('place'));
  if (place) return { type: 'directions', from: UNION_PLACE, to: place };
  return { type: 'home' };
}

export function App() {
  const clock = useClock();
  const data = useShuttleData(clock);
  const { network, timetable, buses } = data;
  const [view, setViewState] = useState<View>(queryToView);
  const [me, setMe] = useState<LatLng | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [satellite, setSatellite] = useState(false);
  const [showCdta, setShowCdta] = useState(readShowCdta);
  const [cdtaDirection, setCdtaDirection] = useState(0);
  const [transitUnavailable, setTransitUnavailable] = useState(false);
  const [sheetExpanded, setSheetExpanded] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [leaveAt, setLeaveAt] = useState<LeaveAt | null>(null);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [planning, setPlanning] = useState(false);
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null);
  const [walkPaths, setWalkPaths] = useState<Map<string, WalkPath>>(new Map());
  const mapRef = useRef<MapHandle>(null);
  /** Set when a selection came from clicking the map: it's already in view, so stay put. */
  const keepCamera = useRef(false);

  const cdta = useCdtaOverview();
  const { vehicles: cdtaVehicles } = useCdtaVehicles(showCdta);
  const cdtaRoutes = useMemo(() => new Map((cdta?.routes ?? []).map((r) => [r.id, r])), [cdta]);
  const cdtaStops = useMemo(() => new Map((cdta?.stops ?? []).map((s) => [s.id, s])), [cdta]);
  const cdtaRoutesNearCampus = useMemo(() => {
    const ids = new Set<string>();
    for (const stop of cdta?.stops ?? []) {
      if (metersBetween(CAMPUS, stop) <= NEAR_CAMPUS_METERS) stop.routes.forEach((r) => ids.add(r));
    }
    return (cdta?.routes ?? []).filter((r) => ids.has(r.id));
  }, [cdta]);

  const index = useMemo(() => (network ? new LocalIndex(PLACES, network, cdta) : null), [network, cdta]);

  const setView = useCallback((next: View, replace = false) => {
    const url = viewToQuery(next);
    if (replace) window.history.replaceState(null, '', url);
    else window.history.pushState(null, '', url);
    setViewState(next);
    setSheetExpanded(false);
  }, []);

  useEffect(() => {
    const onPop = () => setViewState(queryToView());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // --- Location --------------------------------------------------------------------

  const watchId = useRef<number | null>(null);
  const requestLocation = useCallback(async (): Promise<LatLng> => {
    if (!navigator.geolocation) throw new Error("This browser can't share your location.");
    const attempt = (options: PositionOptions) =>
      new Promise<GeolocationPosition>((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, options));
    let position: GeolocationPosition;
    try {
      try {
        // The browser's ordinary fix first: quick, and what nearly every site asks for.
        // watchPosition below then sharpens the location dot once it can.
        position = await attempt({ enableHighAccuracy: false, timeout: 12_000, maximumAge: 300_000 });
      } catch (error) {
        if ((error as GeolocationPositionError).code === 1) throw error;
        position = await attempt({ enableHighAccuracy: true, timeout: 15_000, maximumAge: 300_000 });
      }
    } catch (error) {
      const code = (error as GeolocationPositionError).code;
      if (code === 1) throw new Error('Location access is blocked for this site. You can allow it in your browser settings.');
      throw new Error(`Couldn't get your location (${code === 3 ? 'it took too long' : 'the browser reported it as unavailable'}).`);
    }
    const point = { lat: position.coords.latitude, lng: position.coords.longitude };
    setMe(point);
    setLocationError(null);
    if (watchId.current == null) {
      watchId.current = navigator.geolocation.watchPosition(
        (p) => setMe({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => undefined,
        { enableHighAccuracy: true, maximumAge: 15_000 },
      );
    }
    return point;
  }, []);

  useEffect(() => () => {
    if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current);
  }, []);

  // If the browser already allows it, start from where you are, without ever asking on load.
  useEffect(() => {
    navigator.permissions?.query({ name: 'geolocation' }).then(
      (status) => {
        if (status.state === 'granted') requestLocation().catch(() => undefined);
      },
      () => undefined,
    );
  }, [requestLocation]);

  const mePlace = useCallback((p: LatLng): Place => ({ id: ME_ID, name: 'Your location', ...p, kind: 'me' }), []);

  const useMyLocationFor = useCallback(
    async (slot: 'from' | 'to', current: { from: Place | null; to: Place | null }) => {
      try {
        const point = await requestLocation();
        setView({ type: 'directions', ...current, [slot]: mePlace(point) });
      } catch (error) {
        setLocationError((error as Error).message);
      }
    },
    [requestLocation, setView, mePlace],
  );

  const locateButton = useCallback(async () => {
    try {
      const point = await requestLocation();
      mapRef.current?.fitTo([[point.lng, point.lat]], 16);
    } catch (error) {
      setLocationError((error as Error).message);
    }
  }, [requestLocation]);

  // --- Picking things ------------------------------------------------------------------

  const defaultOrigin = useCallback(
    (): Place => (me && metersBetween(me, CAMPUS) <= MAX_ORIGIN_METERS ? mePlace(me) : UNION_PLACE),
    [me, mePlace],
  );

  const startDirectionsTo = useCallback(
    (to: Place) => {
      setLeaveAt(null);
      setPlan(null);
      setSelectedTripId(null);
      setView({ type: 'directions', from: defaultOrigin(), to });
    },
    [defaultOrigin, setView],
  );

  const openPlace = useCallback(
    (place: Place) => {
      if (place.cdtaRouteId) {
        setCdtaDirection(0);
        setView({ type: 'cdtaRoute', routeId: place.cdtaRouteId });
      } else if (place.cdtaStopId) setView({ type: 'cdtaStop', stopId: place.cdtaStopId });
      else if (place.stopId) setView({ type: 'stop', stopId: place.stopId });
      else startDirectionsTo(place); // A place you searched for is somewhere you want to get to.
    },
    [setView, startDirectionsTo],
  );

  const handleMapPick = useCallback(
    (pick: MapPick) => {
      const asPlace = async (): Promise<Place> => {
        if (pick.type === 'cdtaStop') {
          const stop = cdtaStops.get(pick.stopId);
          if (stop) return cdtaStopToPlace(stop);
          throw new Error('unknown stop');
        }
        if (pick.type === 'stop') return stopToPlace(network!.stopById.get(pick.stopId)!, network!);
        if (pick.type === 'place') return rawToPlace(pick.place);
        const pin: Place = {
          id: `pin:${pick.point.lat},${pick.point.lng}`,
          name: 'Dropped pin',
          ...pick.point,
          kind: 'pin',
        };
        const found = await reverseGeocode(pick.point).catch(() => null);
        return found ? { ...pin, name: found.name, subtitle: found.subtitle } : pin;
      };

      if (view.type === 'directions' && (!view.from || !view.to)) {
        const slot = view.from ? 'to' : 'from';
        void asPlace().then(
          (place) =>
            setViewState((current) => {
              if (current.type !== 'directions') return current;
              const next = { ...current, [slot]: place };
              window.history.replaceState(null, '', viewToQuery(next));
              return next;
            }),
          () => undefined,
        );
        return;
      }
      if (view.type === 'directions') return; // A finished trip shouldn't be changed by a stray click.
      if (pick.type === 'cdtaStop') {
        keepCamera.current = true;
        setView({ type: 'cdtaStop', stopId: pick.stopId });
        return;
      }
      if (pick.type === 'stop') {
        keepCamera.current = true;
        setView({ type: 'stop', stopId: pick.stopId });
        return;
      }
      if (pick.type === 'place') {
        startDirectionsTo(rawToPlace(pick.place));
        return;
      }
      // Plan to the spot right away; fill in its address when that arrives.
      const pin: Place = { id: `pin:${pick.point.lat},${pick.point.lng}`, name: 'Dropped pin', ...pick.point, kind: 'pin' };
      startDirectionsTo(pin);
      void reverseGeocode(pick.point)
        .then((found) => {
          if (!found) return;
          const named = { ...pin, name: found.name, subtitle: found.subtitle };
          setViewState((current) => {
            if (current.type !== 'directions' || current.to?.id !== pin.id) return current;
            const next = { ...current, to: named };
            window.history.replaceState(null, '', viewToQuery(next));
            return next;
          });
        })
        .catch(() => undefined);
    },
    [network, setView, view, cdtaStops, startDirectionsTo],
  );

  // --- Trip planning ---------------------------------------------------------------------

  const directions = view.type === 'directions' ? view : null;
  const from = directions?.from ?? null;
  const to = directions?.to ?? null;
  const fromKey = from ? `${from.lat},${from.lng}` : '';
  const toKey = to ? `${to.lat},${to.lng}` : '';
  // Whole minutes, so an open directions panel re-plans once a minute rather than every tick.
  const startMin = leaveAt ? leaveAt.dayOffset * DAY + leaveAt.minutes : Math.floor(clock.minutes);

  // New endpoints mean the old options, and the choice among them, no longer apply.
  useEffect(() => {
    setPlan(null);
    setSelectedTripId(null);
    setLocationError(null);
  }, [fromKey, toKey]);

  useEffect(() => {
    if (!from || !to || !network || !timetable) return;
    const controller = new AbortController();
    setPlanning(true);
    const shuttleStops = network.routes.flatMap((r) => r.stops);
    const shuttleId = (id: string) => `rpi:${id}`;
    const accessCdta = cdta ? nearestCdtaStops(from, cdta) : [];
    const egressCdta = cdta ? nearestCdtaStops(to, cdta) : [];
    void (async () => {
      await prepareWalkTimes(from, to, [...shuttleStops, ...accessCdta], [...shuttleStops, ...egressCdta], controller.signal);
      if (controller.signal.aborted) return;
      const base = planTrips({ from, to, startMin, network, timetable, walk: walkTime });
      let transit = null;
      if (cdta) {
        const toWalk = (stopId: string, w: ReturnType<typeof estimateWalk>): WalkTo | null =>
          w.meters <= MAX_WALK_LEG_METERS ? { stopId, minutes: w.minutes, meters: w.meters, estimated: w.estimated } : null;
        const access = [
          ...accessCdta.flatMap((s) => toWalk(s.id, walkTime(from, s)) ?? []),
          ...shuttleStops.filter((s) => !s.isReturn).flatMap((s) => toWalk(shuttleId(s.id), walkTime(from, s)) ?? []),
        ];
        const egress = [
          ...egressCdta.flatMap((s) => toWalk(s.id, walkTime(s, to)) ?? []),
          ...shuttleStops.flatMap((s) => toWalk(shuttleId(s.id), walkTime(s, to)) ?? []),
        ];
        transit = await fetchTransitTrips({ from: { lat: from.lat, lng: from.lng, name: from.name }, to: { lat: to.lat, lng: to.lng, name: to.name }, startMin, access, egress }).catch(() => null);
      }
      if (controller.signal.aborted) return;
      setTransitUnavailable(Boolean(cdta) && transit === null);
      setPlan({ ...base, trips: mergeTrips(base.trips, transit ?? []) });
      setPlanning(false);
    })();
    return () => controller.abort();
    // The plan depends on where the ends are, not on the identity of the objects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromKey, toKey, network, timetable, startMin, cdta]);

  // Pin the initial choice, so the order shifting as time passes doesn't switch it.
  useEffect(() => {
    if (plan?.trips.length && !plan.trips.some((t) => t.id === selectedTripId)) setSelectedTripId(plan.trips[0].id);
  }, [plan, selectedTripId]);

  const selectedTrip = useMemo(() => {
    if (!plan) return null;
    return plan.trips.find((t) => t.id === selectedTripId) ?? plan.trips[0] ?? null;
  }, [plan, selectedTripId]);

  const walkLegKeys = (selectedTrip?.legs ?? [])
    .filter((l): l is WalkLeg => l.kind === 'walk')
    .map((l) => walkPathKey(l.from, l.to))
    .join('|');

  useEffect(() => {
    if (!selectedTrip) return;
    let cancelled = false;
    for (const leg of selectedTrip.legs) {
      if (leg.kind !== 'walk') continue;
      void fetchWalkPath(leg.from, leg.to).then((path) => {
        if (cancelled) return;
        setWalkPaths((current) => {
          const id = walkPathKey(leg.from, leg.to);
          if (current.get(id) === path) return current;
          return new Map(current).set(id, path);
        });
      });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walkLegKeys]);

  const tripOverlay = useMemo<TripOverlay | null>(() => {
    if (!selectedTrip || !network) return null;
    const walks: LngLat[][] = [];
    const rides: TripOverlay['rides'] = [];
    const stops: TripOverlay['stops'] = [];
    for (const leg of selectedTrip.legs) {
      if (leg.kind === 'walk') {
        const path = walkPaths.get(walkPathKey(leg.from, leg.to));
        walks.push(path?.coords ?? [[leg.from.lng, leg.from.lat], [leg.to.lng, leg.to.lat]]);
      } else {
        const ride: RideLeg = leg;
        const color = lineColor(ride.color);
        rides.push({ color, path: ride.path });
        stops.push({ ...ride.board, color }, { ...ride.alight, color });
      }
    }
    return { walks, rides, stops };
  }, [selectedTrip, walkPaths, network]);

  // --- Camera: frame whatever was just selected -------------------------------------------

  const selectedStop = view.type === 'stop' ? network?.stopById.get(view.stopId) ?? null : null;
  const selectedRoute = view.type === 'route' ? network?.routeById.get(view.routeId) ?? null : null;
  const selectedBus = view.type === 'bus' ? buses.find((b) => b.id === view.busId) ?? null : null;
  const browseList = useMemo(() => (view.type === 'browse' ? browsePlaces(PLACES, view.cat).map(rawToPlace) : null), [view]);

  // --- CDTA details for whatever is selected ---------------------------------------------

  const cdtaStopDetail = usePolled<CdtaStopDetail | null>(view.type === 'cdtaStop' ? `stop:${view.stopId}` : null, () => callEngine('stop', { id: view.type === 'cdtaStop' ? view.stopId : '' }), CDTA_POLL_MS);
  const cdtaRouteDetail = usePolled<CdtaRouteDetail | null>(view.type === 'cdtaRoute' ? `route:${view.routeId}` : null, () => callEngine('route', { id: view.type === 'cdtaRoute' ? view.routeId : '' }), CDTA_ROUTE_POLL_MS);
  const cdtaBusDetail = usePolled<CdtaVehicleDetail | null>(view.type === 'cdtaBus' ? `bus:${view.vehicleId}` : null, () => callEngine('vehicle', { id: view.type === 'cdtaBus' ? view.vehicleId : '' }), CDTA_POLL_MS);
  const selectedCdtaStop = view.type === 'cdtaStop' ? cdtaStops.get(view.stopId) ?? null : null;
  const selectedCdtaRoute = view.type === 'cdtaRoute' ? cdtaRoutes.get(view.routeId) ?? null : null;
  const selectedCdtaBus = view.type === 'cdtaBus' ? cdtaVehicles.find((v) => v.id === view.vehicleId) ?? cdtaBusDetail.data : null;
  const selectedDirection = cdtaRouteDetail.data?.directions[cdtaDirection] ?? cdtaRouteDetail.data?.directions[0] ?? null;

  const cdtaFocus = useMemo<CdtaFocus | null>(() => {
    if (view.type === 'cdtaRoute' && selectedCdtaRoute && selectedDirection) {
      return { color: lineColor(selectedCdtaRoute.color), paths: [selectedDirection.path], stops: selectedDirection.stops };
    }
    const busRouteId = view.type === 'cdtaBus' ? selectedCdtaBus?.routeId : undefined;
    if (busRouteId) {
      const route = cdtaRoutes.get(busRouteId);
      if (route) return { color: lineColor(route.color), paths: (cdta?.lines ?? []).filter((l) => l.routeId === busRouteId).map((l) => l.coords), stops: [] };
    }
    return null;
  }, [view.type, selectedCdtaRoute, selectedDirection, selectedCdtaBus?.routeId, cdta, cdtaRoutes]);

  const frameKey =
    view.type === 'cdtaStop' ? `cdtaStop:${view.stopId}:${selectedCdtaStop ? 'known' : 'waiting'}` :
    view.type === 'cdtaRoute' ? `cdtaRoute:${view.routeId}:${cdtaDirection}:${selectedDirection ? 'known' : 'waiting'}` :
    view.type === 'cdtaBus' ? `cdtaBus:${view.vehicleId}:${selectedCdtaBus ? 'known' : 'waiting'}` :
    view.type === 'cdtaRoutes' ? 'cdtaRoutes' :
    view.type === 'stop' ? `stop:${view.stopId}` :
    view.type === 'route' ? `route:${view.routeId}` :
    view.type === 'bus' ? `bus:${view.busId}:${selectedBus ? 'known' : 'waiting'}` :
    view.type === 'browse' ? `browse:${view.cat}` :
    view.type === 'directions' ? `dir:${selectedTrip?.id ?? ''}:${fromKey}:${toKey}:${walkLegKeys}:${tripOverlay?.walks.flat().length ?? 0}` :
    'home';

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !network) return;
    if (keepCamera.current) {
      keepCamera.current = false;
      return;
    }
    const allRoutes = (): LngLat[] => network.routes.flatMap((r) => r.legs.flat());
    if (view.type === 'cdtaStop') {
      if (selectedCdtaStop) map.fitTo([[selectedCdtaStop.lng, selectedCdtaStop.lat]], 16.5);
    } else if (view.type === 'cdtaRoute') {
      if (selectedDirection) map.fitTo(selectedDirection.path);
    } else if (view.type === 'cdtaBus') {
      if (selectedCdtaBus) map.fitTo([[selectedCdtaBus.lng, selectedCdtaBus.lat]], 15);
    } else if (view.type === 'cdtaRoutes') {
      // Stay where you are while choosing from the list.
    } else if (view.type === 'home') {
      map.fitTo(allRoutes());
    } else if (view.type === 'stop' && selectedStop) {
      map.fitTo([[selectedStop.lng, selectedStop.lat]], 16.5);
    } else if (view.type === 'route' && selectedRoute) {
      map.fitTo(selectedRoute.legs.flat());
    } else if (view.type === 'bus' && selectedBus) {
      map.fitTo([[selectedBus.lng, selectedBus.lat]], 16);
    } else if (view.type === 'browse' && browseList?.length) {
      map.fitTo(browseList.map((p) => [p.lng, p.lat]));
    } else if (view.type === 'directions') {
      const points: LngLat[] = [];
      if (from) points.push([from.lng, from.lat]);
      if (to) points.push([to.lng, to.lat]);
      tripOverlay?.rides.forEach((r) => points.push(...r.path));
      tripOverlay?.walks.forEach((w) => points.push(...w));
      if (points.length) map.fitTo(points, 17);
    }
    // Only re-frame when the subject changes, not on every live update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameKey, mapReady, network]);

  // --- Render -----------------------------------------------------------------------------

  const quickFor = (slot: 'from' | 'to'): QuickOption[] => {
    const current = { from, to };
    const options: QuickOption[] = [{ id: 'me', label: 'Your location', onSelect: () => void useMyLocationFor(slot, current) }];
    const union = network?.boardingStops.find((s) => s.index === 0);
    if (union) {
      options.push({
        id: 'union',
        label: 'Student Union',
        onSelect: () => {
          setView({ type: 'directions', ...current, [slot]: UNION_PLACE });
        },
      });
    }
    return options;
  };

  // What the search box offers before anything is typed: the whole "home screen".
  const homeOptions: QuickOption[] = [
    ...(network && timetable
      ? network.routes.map((route): QuickOption => {
          const next = timetable.next(route.id, clock.minutes);
          return {
            id: `route:${route.id}`,
            group: 'Shuttles',
            label: route.name,
            sub: next != null ? `Next ${formatTimeWithDay(next, clock)}` : undefined,
            onSelect: () => setView({ type: 'route', routeId: route.id }),
          };
        })
      : []),
    ...(cdta ? [{ id: 'cdta-routes', group: 'CDTA', label: 'All routes', onSelect: () => setView({ type: 'cdtaRoutes' }) }] : []),
    ...BROWSE.map(({ cat, label }): QuickOption => ({ id: `browse:${cat}`, group: 'Explore', label, onSelect: () => setView({ type: 'browse', cat, label }) })),
  ];

  const openCdtaRoute = (id: string) => {
    setCdtaDirection(0);
    setView({ type: 'cdtaRoute', routeId: id });
  };
  const openCdtaStop = (id: string) => setView({ type: 'cdtaStop', stopId: id });
  const openCdtaBus = (id: string) => setView({ type: 'cdtaBus', vehicleId: id });

  const panelBody = () => {
    if (!network || !timetable) return view.type === 'home' ? null : <p className="muted panel-body" role="status">Loading…</p>;
    const back = () => setView({ type: 'home' });
    switch (view.type) {
      case 'home':
        return null;
      case 'browse':
        return <BrowsePanel title={view.label} places={browseList ?? []} onBack={back} onPick={openPlace} />;
      case 'stop':
        if (!selectedStop) return <NotFound text="That stop isn't on the current routes." onBack={back} />;
        return (
          <StopPanel
            stop={selectedStop}
            network={network}
            timetable={timetable}
            clock={clock}
            buses={buses}
            onBack={back}
            onDirections={() => startDirectionsTo(stopToPlace(selectedStop, network))}
            onStop={(id) => setView({ type: 'stop', stopId: id })}
            onRoute={(id) => setView({ type: 'route', routeId: id })}
            onBus={(id) => setView({ type: 'bus', busId: id })}
          />
        );
      case 'route':
        if (!selectedRoute) return <NotFound text="That route isn't running." onBack={back} />;
        return (
          <RoutePanel
            route={selectedRoute}
            timetable={timetable}
            clock={clock}
            buses={buses}
            onBack={back}
            onStop={(id) => setView({ type: 'stop', stopId: id })}
            onBus={(id) => setView({ type: 'bus', busId: id })}
          />
        );
      case 'bus':
        if (!selectedBus) return <NotFound text="That bus isn't reporting a position right now." onBack={back} />;
        return (
          <BusPanel
            bus={selectedBus}
            onBack={back}
            onStop={(s) => setView({ type: 'stop', stopId: s.isReturn ? selectedBus.route!.stops[0].id : s.id })}
          />
        );
      case 'cdtaRoutes':
        if (!cdta) return <p className="muted panel-body" role="status">Loading CDTA routes…</p>;
        return <CdtaRoutesPanel overview={cdta} nearCampus={cdtaRoutesNearCampus} onBack={back} onRoute={openCdtaRoute} />;
      case 'cdtaStop':
        if (!cdta) return <p className="muted panel-body" role="status">Loading CDTA stops…</p>;
        if (!selectedCdtaStop) return <NotFound text="That CDTA stop isn't in the current schedule." onBack={back} />;
        return (
          <CdtaStopPanel
            stop={selectedCdtaStop}
            routes={cdtaRoutes}
            detail={cdtaStopDetail.data}
            failed={cdtaStopDetail.failed}
            clock={clock}
            onBack={back}
            onDirections={() => startDirectionsTo(cdtaStopToPlace(selectedCdtaStop))}
            onRoute={openCdtaRoute}
            onBus={openCdtaBus}
          />
        );
      case 'cdtaRoute':
        if (!cdta) return <p className="muted panel-body" role="status">Loading CDTA routes…</p>;
        if (!selectedCdtaRoute) return <NotFound text="That CDTA route isn't in the current schedule." onBack={back} />;
        return (
          <CdtaRoutePanel
            route={selectedCdtaRoute}
            detail={cdtaRouteDetail.data}
            failed={cdtaRouteDetail.failed}
            directionIndex={cdtaDirection}
            vehicles={cdtaVehicles}
            onDirectionIndex={setCdtaDirection}
            onBack={back}
            onStop={openCdtaStop}
            onBus={openCdtaBus}
          />
        );
      case 'cdtaBus':
        return (
          <CdtaBusPanel
            vehicle={cdtaVehicles.find((v) => v.id === view.vehicleId) ?? null}
            detail={cdtaBusDetail.data}
            failed={cdtaBusDetail.failed}
            onBack={back}
            onRoute={openCdtaRoute}
            onStop={openCdtaStop}
          />
        );
      case 'directions':
        return (
          <DirectionsResults
            from={from}
            to={to}
            plan={plan}
            loading={planning}
            selectedTripId={selectedTrip?.id ?? null}
            network={network}
            clock={clock}
            buses={buses}
            walkPaths={walkPaths}
            leaveAt={leaveAt}
            locationError={locationError}
            transitUnavailable={transitUnavailable}
            onLeaveAt={setLeaveAt}
            onSelectTrip={setSelectedTripId}
            onUseMyLocation={() => void useMyLocationFor('from', { from, to })}
            onPickStartOnMap={() => setView({ type: 'directions', from: null, to }, true)}
          />
        );
    }
  };

  // A new subject starts scrolled to the top; a live update or a new trip option doesn't.
  const panelKey = view.type === 'directions' ? `directions:${fromKey}:${toKey}` : frameKey;

  // Looking at one route or trip, the only CDTA buses that matter are the ones on it.
  const cdtaOnMap = useMemo(() => {
    if (view.type === 'directions' && selectedTrip) {
      const routes = new Set(selectedTrip.legs.flatMap((l) => (l.kind === 'ride' && l.agency === 'cdta' ? [l.routeId] : [])));
      return cdtaVehicles.filter((v) => routes.has(v.routeId));
    }
    if (view.type === 'route' || view.type === 'stop' || view.type === 'bus') return [];
    const focusRoute = view.type === 'cdtaRoute' ? view.routeId : view.type === 'cdtaBus' ? selectedCdtaBus?.routeId : null;
    return focusRoute ? cdtaVehicles.filter((v) => v.routeId === focusRoute) : cdtaVehicles;
  }, [view, selectedTrip, cdtaVehicles, selectedCdtaBus?.routeId]);

  const focusRouteId =
    view.type === 'route' ? view.routeId :
    view.type === 'stop' ? selectedStop?.routeId ?? null :
    view.type === 'bus' ? selectedBus?.route?.id ?? null :
    null;
  const focus = Boolean(tripOverlay || cdtaFocus || focusRouteId);

  // Likewise for shuttle buses: with something selected, only the relevant ones show.
  const busesOnMap = useMemo(() => {
    if (view.type === 'directions' && selectedTrip) {
      const routes = new Set(selectedTrip.legs.flatMap((l) => (l.kind === 'ride' && l.agency === 'rpi' ? [l.routeId.replace(/^rpi:/, '')] : [])));
      return buses.filter((b) => b.route && routes.has(b.route.id));
    }
    if (cdtaFocus) return [];
    return focusRouteId ? buses.filter((b) => b.route?.id === focusRouteId) : buses;
  }, [view.type, selectedTrip, cdtaFocus, focusRouteId, buses]);

  // The search box names whatever is open, and clears when nothing is.
  const searchValue =
    view.type === 'stop' ? selectedStop?.name ?? '' :
    view.type === 'route' ? selectedRoute?.name ?? '' :
    view.type === 'cdtaStop' ? selectedCdtaStop?.name ?? '' :
    view.type === 'cdtaRoute' ? (selectedCdtaRoute ? `CDTA ${selectedCdtaRoute.short}` : '') :
    '';

  const pin: Place | null =
    view.type === 'directions' ? to : null;

  const body = panelBody();
  const cdtaExpired = Boolean(cdta?.feed.end) && cdta!.feed.end < clock.dateKey;

  return (
    <div className={`app ${sheetExpanded ? 'sheet-expanded' : ''} ${body ? 'has-panel' : ''}`} data-ready={network ? 'yes' : 'no'}>
      <MapView
        ref={mapRef}
        network={network}
        labelledPlaces={LABELLED}
        buses={busesOnMap}
        pin={pin}
        origin={from && from.id !== ME_ID ? from : null}
        me={me}
        browse={browseList}
        trip={tripOverlay}
        focus={focus}
        focusRouteId={focusRouteId}
        selectedStopId={view.type === 'stop' ? view.stopId : null}
        selectedBusId={view.type === 'bus' ? view.busId : view.type === 'cdtaBus' ? `${CDTA_BUS_PREFIX}${view.vehicleId}` : null}
        satellite={satellite}
        cdta={cdta}
        showCdta={showCdta}
        cdtaVehicles={cdtaOnMap}
        cdtaFocus={cdtaFocus}
        selectedCdtaStopId={view.type === 'cdtaStop' ? view.stopId : null}
        onPick={handleMapPick}
        onBusClick={(id) => {
          keepCamera.current = true;
          if (id.startsWith(CDTA_BUS_PREFIX)) setView({ type: 'cdtaBus', vehicleId: id.slice(CDTA_BUS_PREFIX.length) });
          else setView({ type: 'bus', busId: id });
        }}
        onReady={() => setMapReady(true)}
      />

      <div className="sidebar">
        <div className="search-area">
          {directions ? (
            <div className="directions-form">
              <button type="button" className="icon-btn" aria-label="Close directions" onClick={() => setView({ type: 'home' })}>
                <BackIcon size={18} />
              </button>
              <div className="directions-fields">
                <SearchBox
                  index={index}
                  placesOnly
                  value={from?.name ?? ''}
                  placeholder="Start"
                  ariaLabel="Starting point"
                  autoFocus={!from && !!to}
                  leading={<span className="field-dot is-from" />}
                  quickOptions={quickFor('from')}
                  onPick={(p) => setView({ type: 'directions', from: p, to })}
                  onClear={() => setView({ type: 'directions', from: null, to }, true)}
                />
                <SearchBox
                  index={index}
                  placesOnly
                  value={to?.name ?? ''}
                  placeholder="Destination"
                  ariaLabel="Destination"
                  autoFocus={!to}
                  leading={<span className="field-dot is-to" />}
                  quickOptions={quickFor('to')}
                  onPick={(p) => setView({ type: 'directions', from, to: p })}
                  onClear={() => setView({ type: 'directions', from, to: null }, true)}
                />
              </div>
              <button type="button" className="icon-btn" aria-label="Swap start and destination" onClick={() => setView({ type: 'directions', from: to, to: from })}>
                <SwapIcon size={17} />
              </button>
            </div>
          ) : (
            <SearchBox
              index={index}
              value={searchValue}
              placeholder="Search"
              ariaLabel="Search for a place"
              quickOptions={homeOptions}
              onPick={openPlace}
              onClear={() => setView({ type: 'home' })}
              trailing={
                <button type="button" className="icon-btn" aria-label="Get directions" onClick={() => setView({ type: 'directions', from: defaultOrigin(), to: null })}>
                  <DirectionsIcon size={18} />
                </button>
              }
            />
          )}
        </div>

        {data.announcements.map((a) => <div key={a.id} className="banner" role="status">{a.message}</div>)}
        {data.staticFailed && <div className="banner" role="alert">Can't load the shuttle routes. Trying again…</div>}
        {data.liveFailed && <div className="banner" role="status">Live bus positions aren't updating. Schedule times still work.</div>}
        {cdtaExpired && <div className="banner" role="status">CDTA schedule data is out of date.</div>}
        {view.type !== 'directions' && locationError && (
          <div className="banner" role="alert">
            {locationError}
            <button type="button" onClick={() => setLocationError(null)}>Dismiss</button>
          </div>
        )}

        {body && (
          <div className="panel">
            <button
              type="button"
              className="sheet-handle"
              aria-label={sheetExpanded ? 'Show more map' : 'Show more details'}
              aria-expanded={sheetExpanded}
              onClick={() => setSheetExpanded(!sheetExpanded)}
            >
              <span />
            </button>
            <div className="panel-scroll" key={panelKey}>{body}</div>
          </div>
        )}
      </div>

      <MapControls
        satellite={satellite}
        showCdta={showCdta}
        onSatellite={setSatellite}
        onShowCdta={(next) => {
          setShowCdta(next);
          try {
            localStorage.setItem(SHOW_CDTA_KEY, next ? 'on' : 'off');
          } catch {
            // The choice just won't be remembered next time.
          }
        }}
        onLocate={() => void locateButton()}
      />
      {!LIVE_URL && <p className="map-caption">Schedules only. Live buses aren't connected.</p>}
    </div>
  );
}

function NotFound({ text, onBack }: { text: string; onBack(): void }) {
  return (
    <div className="panel-body">
      <p className="muted">{text}</p>
      <button type="button" className="link" onClick={onBack}>Back to the map</button>
    </div>
  );
}

