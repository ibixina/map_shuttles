# RPI Shuttle Map

A simple map of the [RPI shuttles](https://shuttles.rpi.edu/) and CDTA buses, for people who
don't know the area. It's an unofficial project, not affiliated with RPI or CDTA, using their
public data. Bus data is provided by CDTA under its
[Developer License Agreement](https://www.cdta.org/developer-license-agreement/169).

- **Search** buildings (including nicknames like "DCC" or "the Union"), stops, bus routes by
  number, and any address around Troy.
- **Directions** combining walking, the shuttles and CDTA.
- **Routes and stops** with next departures, live predictions and alerts.

## How it's hosted

The site is entirely static, so it runs on GitHub Pages. Everything happens in the browser:

| Part | Where it comes from |
| --- | --- |
| Routes, stops, schedules | `public/data/`, rebuilt daily by `.github/workflows/deploy.yml` (about 320 KB gzipped) |
| Trip planning | Runs in the browser, in a background worker |
| Campus places | `src/data/places.json`, from OpenStreetMap (`npm run places` to refresh) |
| Map, satellite | OpenFreeMap; USGS, and NY State orthoimagery when zoomed in |
| Address search, walking routes | Photon; Valhalla, then OSRM |
| **Live buses, predictions, alerts** | The relay in `worker/`, which is optional |

### Publishing to GitHub Pages

1. Make this folder its own GitHub repository and push it.
2. In the repository's Settings > Pages, set the source to **GitHub Actions**.

The site then deploys on every push, and daily. It works at any address, including
`username.github.io/repo/`. If the schedule ever stops updating, the site says so; check that
the workflow is still enabled under the Actions tab.

### Turning on live buses

Browsers can't read the live feeds directly: neither source allows it (no CORS headers), and
CDTA's is plain HTTP. So a small relay has to pass them along. `worker/live-proxy.mjs` is one
for Cloudflare Workers' free plan:

```sh
cd worker
npx wrangler deploy
```

That prints an address. Add it as a repository variable named `LIVE_URL` (Settings > Secrets
and variables > Actions > Variables), then re-run the Deploy workflow. To stop other sites
using your relay, set `ALLOWED_ORIGINS` in `worker/wrangler.toml` to your site's origin.

Each open tab makes about 840 relay requests an hour, and the free plan allows 100,000 a day,
or about 120 hours of viewing a day in total. Tabs in the background don't poll.

Without the relay, the site shows schedules, and says live buses aren't connected.

## Running it locally

```sh
npm install
npm run dev                  # development; live data goes through a local copy of the relay
npm run build && npm start   # as it will be hosted: static files plus a separate relay
```

`npm run data` refreshes `public/data/`. `npm start` needs `VITE_LIVE_URL=http://localhost:8787`
set during `npm run build` to show live data.

## Tests

```sh
npm test
PLAYWRIGHT_PATH=/path/to/playwright/index.mjs npm run test:e2e -- http://localhost:4173/shuttle-map ./shots
```

The browser test needs `npm start` running, and uses the live services.

## Worth knowing

- **Bus details:** clicking a shuttle shows everything the API reports, including the driver's
  name and ID, VIN, license plate and tracker details. On a public site anyone can see these.
  The relay doesn't expose the day's position history (`/api/today`).
- **CDTA filtering:** route 93 (STAR paratransit) and maintenance vehicles appear in CDTA's
  feeds but can't be boarded, so they are left out.
- **Third parties:** searches go directly from the browser to Photon, and trip start and end
  points to the routing servers. That includes your position if you use "Your location".
- **Schedule times** are the published ones, always in Troy time. They don't cover holidays or
  breaks, and the app says so.
- **Public servers:** Photon, Valhalla and OSRM are free community services with usage limits.
# map_shuttles
