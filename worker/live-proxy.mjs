// A tiny relay for the live feeds, for hosting the site on GitHub Pages. Browsers can't
// read these feeds directly: neither source sends CORS headers, and CDTA's is plain HTTP.
// It only passes along an allow-listed set of feeds, and caches them, so any number of
// viewers makes the same few requests upstream. Deploy with: cd worker && npx wrangler deploy
const SHUTTLE = 'https://shuttles.rpi.edu/api/';
const CDTA_LIVE = 'http://gtfs.cdta.org:8080/gtfsrealtime/';
const CDTA_ALERTS = 'https://www.cdta.org/gtfsrealtime/ServiceAlerts';

const SHUTTLE_FEEDS = { locations: 4, velocities: 4, etas: 15, announcements: 300 };
const BINARY_FEEDS = {
  '/cdta/vehicles': { url: `${CDTA_LIVE}VehiclePositions`, ttl: 12 },
  '/cdta/trip-updates': { url: `${CDTA_LIVE}TripUpdates`, ttl: 12 },
  '/cdta/alerts': { url: CDTA_ALERTS, ttl: 300 },
};

export function createHandler({ fetchImpl = fetch, now = Date.now } = {}) {
  const cache = new Map(); // url -> { at, body }
  const inflight = new Map(); // url -> Promise<body>

  async function fetchCached(url, ttlSeconds, read) {
    const hit = cache.get(url);
    if (hit && now() - hit.at < ttlSeconds * 1000) return hit.body;
    let pending = inflight.get(url);
    if (!pending) {
      pending = (async () => {
        const res = await fetchImpl(url, {
          headers: { 'user-agent': 'shuttle-map' },
          signal: AbortSignal.timeout(8_000),
          cf: { cacheTtl: ttlSeconds, cacheEverything: true }, // Shared across Cloudflare's servers.
        });
        if (!res.ok) throw new Error(`upstream ${res.status}`);
        const body = await read(res);
        cache.set(url, { at: now(), body });
        return body;
      })().finally(() => inflight.delete(url));
      inflight.set(url, pending);
    }
    try {
      return await pending;
    } catch (error) {
      if (hit) return hit.body; // Better slightly old than nothing.
      throw error;
    }
  }

  function corsHeaders(origin, allowed) {
    const list = (allowed ?? '*').split(',').map((s) => s.trim());
    if (list.includes('*')) return { 'access-control-allow-origin': '*' };
    if (origin && list.includes(origin)) return { 'access-control-allow-origin': origin, vary: 'origin' };
    return null;
  }

  return async function handle(request, env = {}) {
    const url = new URL(request.url);
    const cors = corsHeaders(request.headers.get('origin'), env.ALLOWED_ORIGINS);
    if (!cors) return new Response('Not allowed', { status: 403 });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'access-control-allow-methods': 'GET' } });
    if (request.method !== 'GET') return new Response('Not allowed', { status: 405, headers: cors });
    const headers = { ...cors, 'cache-control': 'no-store' };

    try {
      if (url.pathname === '/shuttle') {
        // One request for all of it: each is otherwise a separate billable request.
        const entries = await Promise.all(
          Object.entries(SHUTTLE_FEEDS).map(async ([name, ttl]) => {
            try {
              return [name, await fetchCached(SHUTTLE + name, ttl, (res) => res.json())];
            } catch {
              return [name, null];
            }
          }),
        );
        const body = Object.fromEntries(entries);
        if (!body.locations) throw new Error('no locations');
        return new Response(JSON.stringify(body), { headers: { ...headers, 'content-type': 'application/json' } });
      }
      const feed = BINARY_FEEDS[url.pathname];
      if (feed) {
        const body = await fetchCached(feed.url, feed.ttl, (res) => res.arrayBuffer());
        return new Response(body, { headers: { ...headers, 'content-type': 'application/x-protobuf' } });
      }
      return new Response('Not found', { status: 404, headers });
    } catch {
      return new Response('Upstream unavailable', { status: 502, headers });
    }
  };
}

const handler = createHandler();
export default { fetch: (request, env) => handler(request, env) };
