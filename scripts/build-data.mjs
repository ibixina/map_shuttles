// Downloads CDTA's schedule and the shuttle's routes and schedule, and writes the static
// files the site loads from public/data/. GitHub Actions runs this daily. If a source is
// down, the existing file is kept, so a bad day never breaks the site.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { parseFeedZip } from '../src/transit/gtfs-zip.mjs';
import { compactFeed } from '../src/transit/gtfs.mjs';
import { buildOverview } from '../src/transit/queries.mjs';

const OUT = new URL('../public/data/', import.meta.url);
const FEED_URL = 'https://www.cdta.org/schedules/google_transit.zip';
const SHUTTLE = 'https://shuttles.rpi.edu/api/';
const headers = { 'user-agent': 'shuttle-map data build' };

mkdirSync(OUT, { recursive: true });

async function saveShuttle(name, file) {
  try {
    const res = await fetch(SHUTTLE + name, { headers, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`${res.status}`);
    writeFileSync(new URL(file, OUT), JSON.stringify(await res.json()));
    return true;
  } catch (error) {
    console.warn(`Keeping the existing ${file}: ${error.message}`);
    return false;
  }
}

async function saveCdta() {
  try {
    const local = process.argv[2]; // A zip already on disk, instead of downloading.
    let bytes;
    if (local) bytes = readFileSync(local);
    else {
      const res = await fetch(FEED_URL, { headers, signal: AbortSignal.timeout(180_000) });
      if (!res.ok) throw new Error(`${res.status}`);
      bytes = new Uint8Array(await res.arrayBuffer());
    }
    const feed = parseFeedZip(bytes);
    const overview = buildOverview(feed);
    writeFileSync(new URL('cdta-overview.json', OUT), JSON.stringify(overview));
    writeFileSync(new URL('cdta-schedule.json', OUT), JSON.stringify(compactFeed(feed, overview.stops)));
    return overview.feed.end;
  } catch (error) {
    console.warn(`Keeping the existing CDTA data: ${error.message}`);
    return null;
  }
}

await Promise.all([saveShuttle('routes', 'shuttle-routes.json'), saveShuttle('schedule', 'shuttle-schedule.json')]);
const feedEnd = await saveCdta();

// The month changes on purpose: a commit at least monthly stops GitHub disabling the daily
// schedule, which it does to repositories with 60 days of no activity.
const stamp = { builtMonth: new Date().toISOString().slice(0, 7), ...(feedEnd ? { cdtaFeedEnd: feedEnd } : {}) };
try {
  const previous = JSON.parse(readFileSync(new URL('meta.json', OUT), 'utf8'));
  stamp.cdtaFeedEnd ??= previous.cdtaFeedEnd;
} catch {
  // First build.
}
writeFileSync(new URL('meta.json', OUT), JSON.stringify(stamp));

for (const file of ['cdta-overview.json', 'cdta-schedule.json', 'shuttle-routes.json', 'shuttle-schedule.json', 'meta.json']) {
  try {
    console.log(file.padEnd(24), `${Math.round(statSync(new URL(file, OUT)).size / 1024)} KB`);
  } catch {
    console.warn(`${file} is missing`);
  }
}
