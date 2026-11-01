// Runs schedule lookups and trip planning off the main thread, so the map stays smooth.
// Loads the CDTA schedule on first use, and reads live CDTA feeds through the relay.
import { feedFromCompact } from './gtfs.mjs';
import { decodeFeedMessage } from './gtfsrt.mjs';
import { buildPlanner } from './planner.mjs';
import { indexTripUpdates, listAlerts, listVehicles, predicted, routeDetail, stopArrivals, troyNow, vehicleDetail } from './queries.mjs';

let dataBase = '';
let liveBase = '';

async function getJson(name: string) {
  const res = await fetch(`${dataBase}${name}`);
  if (!res.ok) throw new Error(`${name}: ${res.status}`);
  return res.json();
}

let feedPromise: Promise<any> | null = null;
function getFeed() {
  feedPromise ??= (async () => {
    const [overview, schedule] = await Promise.all([getJson('cdta-overview.json'), getJson('cdta-schedule.json')]);
    return feedFromCompact(overview, schedule);
  })().catch((error) => {
    feedPromise = null;
    throw error;
  });
  return feedPromise;
}

let plannerPromise: Promise<any> | null = null;
function getPlanner() {
  plannerPromise ??= (async () => {
    const [feed, routes, schedule] = await Promise.all([getFeed(), getJson('shuttle-routes.json'), getJson('shuttle-schedule.json')]);
    return buildPlanner(feed, { routes, schedule });
  })().catch((error) => {
    plannerPromise = null;
    throw error;
  });
  return plannerPromise;
}

function liveFeed(path: string, ttlMs: number) {
  let value: any = null;
  let at = 0;
  let pending: Promise<any> | null = null;
  return async () => {
    if (!liveBase) throw new Error('No live relay configured');
    if (value && Date.now() - at < ttlMs) return value;
    pending ??= fetch(`${liveBase}${path}`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        value = decodeFeedMessage(await res.arrayBuffer());
        at = Date.now();
        return value;
      })
      .finally(() => {
        pending = null;
      });
    try {
      return await pending;
    } catch (error) {
      if (value) return value;
      throw error;
    }
  };
}

const vehicles = liveFeed('/cdta/vehicles', 12_000);
const tripUpdates = liveFeed('/cdta/trip-updates', 12_000);
const alerts = liveFeed('/cdta/alerts', 300_000);
const safeUpdates = async () => indexTripUpdates(await tripUpdates().catch(() => null));
const safeAlerts = async () => listAlerts(await alerts().catch(() => null));

const methods: Record<string, (arg: any) => Promise<unknown>> = {
  async init(arg) {
    dataBase = arg.dataBase;
    liveBase = arg.liveBase;
    return true;
  },
  async vehicles() {
    if (!liveBase) return [];
    const [feed, message] = await Promise.all([getFeed(), vehicles()]);
    return listVehicles(feed, message, Date.now() / 1000);
  },
  async vehicle({ id }) {
    const [feed, message, updates] = await Promise.all([getFeed(), vehicles(), safeUpdates()]);
    const now = troyNow();
    const vehicle = listVehicles(feed, message, now.epoch).find((v: { id: string }) => v.id === id);
    return vehicle ? vehicleDetail(feed, vehicle, updates, now) : null;
  },
  async stop({ id }) {
    const feed = await getFeed();
    const stopIndex = feed.stopIndex.get(id);
    if (stopIndex === undefined) return null;
    const [updates, allAlerts] = await Promise.all([safeUpdates(), safeAlerts()]);
    const now = troyNow();
    const routes = new Set(feed.rowsAtStop[stopIndex].map((row: number) => feed.trips[feed.tripOfRow[row]].routeId));
    return {
      nowMin: now.minutes,
      arrivals: stopArrivals(feed, stopIndex, now, updates),
      alerts: allAlerts.filter((a: any) => a.stops.includes(id) || (!a.stops.length && a.routes.some((r: string) => routes.has(r)))),
    };
  },
  async route({ id }) {
    const feed = await getFeed();
    const detail = routeDetail(feed, id, troyNow());
    if (!detail) return null;
    const allAlerts = await safeAlerts();
    return { ...detail, alerts: allAlerts.filter((a: any) => a.routes.includes(id)) };
  },
  async plan(input) {
    const planner = await getPlanner();
    const now = troyNow();
    const trips = planner.plan({ ...input, startMin: Math.max(input.startMin, now.minutes - 1), today: now.today });
    const updates = await safeUpdates();
    for (const trip of trips) {
      for (const leg of trip.legs) {
        if (leg.kind !== 'ride' || leg.agency !== 'cdta') continue;
        const at = predicted(updates.get(leg.tripId), leg.serviceDate, -1, leg.board.id);
        if (at) leg.liveDepartMin = now.minutes + (at - now.epoch) / 60;
      }
    }
    return trips;
  },
};

self.onmessage = async (event: MessageEvent) => {
  const { id, method, arg } = event.data;
  try {
    self.postMessage({ id, ok: true, result: await methods[method](arg) });
  } catch (error) {
    self.postMessage({ id, ok: false, error: (error as Error).message });
  }
};
