// Build-time only: reads the GTFS zip CDTA publishes.
import { strFromU8, unzipSync } from 'fflate';
import { buildFeed } from './gtfs.mjs';

const WANTED_FILES = ['routes.txt', 'stops.txt', 'trips.txt', 'stop_times.txt', 'shapes.txt', 'calendar.txt', 'calendar_dates.txt', 'feed_info.txt'];

export function parseFeedZip(zipBytes) {
  const entries = unzipSync(zipBytes, { filter: (file) => WANTED_FILES.includes(file.name) });
  const files = {};
  for (const name of WANTED_FILES) if (entries[name]) files[name] = strFromU8(entries[name]);
  return buildFeed(files);
}
