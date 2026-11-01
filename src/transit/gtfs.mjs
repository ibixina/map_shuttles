// GTFS tables. buildFeed parses the raw text feed (at build time: stop_times alone is
// 50 MB). compactFeed shrinks that to a small file for the site, and feedFromCompact
// rebuilds the same tables from it in the browser, so all queries work on either.

/** Route 93 is CDTA's STAR paratransit service: pre-booked, so nobody can just board it. */
const NON_PASSENGER_ROUTES = new Set(['93']);
const NON_PASSENGER_TRIP = /-(MAINTEN|Star)-/;

export function isPassengerTrip(routeId, tripId = '') {
  return !NON_PASSENGER_ROUTES.has(routeId) && !NON_PASSENGER_TRIP.test(tripId);
}

export const FLAG_NO_PICKUP = 1;
export const FLAG_NO_DROPOFF = 2;

function splitCsvLine(line) {
  if (!line.includes('"')) return line.split(',');
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(field);
      field = '';
    } else field += c;
  }
  out.push(field);
  return out;
}

/** Calls `onRow(fields, column)` per data row. Avoids per-row objects for large files. */
function eachRow(text, onRow) {
  const start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let lineEnd = text.indexOf('\n', start);
  if (lineEnd === -1) return;
  const header = splitCsvLine(text.slice(start, lineEnd).replace(/\r$/, ''));
  const column = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  let pos = lineEnd + 1;
  while (pos < text.length) {
    lineEnd = text.indexOf('\n', pos);
    if (lineEnd === -1) lineEnd = text.length;
    const line = text.slice(pos, text[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd);
    pos = lineEnd + 1;
    if (line) onRow(splitCsvLine(line), column);
  }
}

function rows(text) {
  const out = [];
  if (!text) return out;
  eachRow(text, (fields, column) => {
    const row = {};
    for (const [name, i] of Object.entries(column)) row[name] = fields[i] ?? '';
    out.push(row);
  });
  return out;
}

/** "25:10:00" to seconds after the service day's midnight; GTFS times run past 24:00. */
export function parseGtfsTime(text) {
  const m = /^\s*(\d+):(\d\d):(\d\d)\s*$/.exec(text ?? '');
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : -1;
}

const hex = (value, fallback) => (/^[0-9a-f]{6}$/i.test(value ?? '') ? `#${value.toLowerCase()}` : fallback);

export function weekdayOf(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addDays(dateKey, days) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const WEEKDAY_COLUMNS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const gtfsDate = (text) => `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;

/** `files` maps a GTFS file name to its text. */
export function buildFeed(files) {
  const routeList = [];
  const routes = new Map();
  for (const r of rows(files['routes.txt'])) {
    if (!isPassengerTrip(r.route_id)) continue;
    const route = {
      id: r.route_id,
      short: r.route_short_name || r.route_id,
      long: r.route_long_name,
      desc: r.route_desc,
      color: hex(r.route_color, '#123573'),
      textColor: hex(r.route_text_color, '#ffffff'),
      sort: Number(r.route_sort_order) || 0,
    };
    routes.set(route.id, route);
    routeList.push(route);
  }
  routeList.sort((a, b) => a.sort - b.sort);

  const stops = [];
  const stopIndex = new Map();
  for (const s of rows(files['stops.txt'])) {
    const lat = Number(s.stop_lat);
    const lng = Number(s.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    stopIndex.set(s.stop_id, stops.length);
    stops.push({ id: s.stop_id, code: s.stop_code, name: s.stop_name, lat, lng });
  }

  const trips = [];
  const tripIndex = new Map();
  for (const t of rows(files['trips.txt'])) {
    if (!routes.has(t.route_id) || !isPassengerTrip(t.route_id, t.trip_id)) continue;
    tripIndex.set(t.trip_id, trips.length);
    trips.push({
      id: t.trip_id,
      routeId: t.route_id,
      serviceId: t.service_id,
      headsign: t.trip_headsign,
      direction: t.direction_id === '1' ? 1 : 0,
      shapeId: t.shape_id,
    });
  }

  // stop_times: counted first so the typed arrays can be allocated once.
  const text = files['stop_times.txt'] ?? '';
  let capacity = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) capacity++;
  const rawTrip = new Int32Array(capacity);
  const rawSeq = new Int32Array(capacity);
  const rawStop = new Int32Array(capacity);
  const rawArr = new Int32Array(capacity);
  const rawDep = new Int32Array(capacity);
  const rawFlags = new Uint8Array(capacity);
  let count = 0;
  let sorted = true;
  eachRow(text, (f, c) => {
    const trip = tripIndex.get(f[c.trip_id]);
    const stop = stopIndex.get(f[c.stop_id]);
    if (trip === undefined || stop === undefined) return;
    const seq = Number(f[c.stop_sequence]);
    if (count > 0 && (rawTrip[count - 1] > trip || (rawTrip[count - 1] === trip && rawSeq[count - 1] >= seq))) sorted = false;
    rawTrip[count] = trip;
    rawSeq[count] = seq;
    rawStop[count] = stop;
    rawArr[count] = parseGtfsTime(f[c.arrival_time]);
    rawDep[count] = parseGtfsTime(f[c.departure_time]);
    rawFlags[count] =
      (f[c.pickup_type] === '1' ? FLAG_NO_PICKUP : 0) | (f[c.drop_off_type] === '1' ? FLAG_NO_DROPOFF : 0);
    count++;
  });

  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  if (!sorted) order.sort((a, b) => rawTrip[a] - rawTrip[b] || rawSeq[a] - rawSeq[b]);

  const stStart = new Int32Array(trips.length + 1);
  const stStop = new Int32Array(count);
  const stSeq = new Int32Array(count);
  const stArr = new Int32Array(count);
  const stDep = new Int32Array(count);
  const stFlags = new Uint8Array(count);
  for (let i = 0; i < count; i++) stStart[rawTrip[i] + 1]++;
  for (let i = 0; i < trips.length; i++) stStart[i + 1] += stStart[i];
  for (let i = 0; i < count; i++) {
    const from = order[i];
    stStop[i] = rawStop[from];
    stSeq[i] = rawSeq[from];
    stFlags[i] = rawFlags[from];
    const dep = rawDep[from];
    const arr = rawArr[from];
    // Times may be blank between timepoints: carry the last known one forward.
    const previous = i > 0 && order[i - 1] !== undefined && rawTrip[order[i - 1]] === rawTrip[from] ? stDep[i - 1] : 0;
    stArr[i] = arr >= 0 ? arr : dep >= 0 ? dep : previous;
    stDep[i] = dep >= 0 ? dep : stArr[i];
  }

  // Shapes, as flat [lng, lat, ...] arrays in sequence order.
  const shapePoints = new Map();
  eachRow(files['shapes.txt'] ?? '', (f, c) => {
    const id = f[c.shape_id];
    let list = shapePoints.get(id);
    if (!list) shapePoints.set(id, (list = []));
    list.push(Number(f[c.shape_pt_sequence]), Number(f[c.shape_pt_lon]), Number(f[c.shape_pt_lat]));
  });
  const shapes = new Map();
  for (const [id, list] of shapePoints) {
    const n = list.length / 3;
    const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => list[a * 3] - list[b * 3]);
    const coords = new Float64Array(n * 2);
    idx.forEach((from, i) => {
      coords[i * 2] = list[from * 3 + 1];
      coords[i * 2 + 1] = list[from * 3 + 2];
    });
    shapes.set(id, coords);
  }

  const calendarEntries = rows(files['calendar.txt']).map((c) => ({
    id: c.service_id,
    days: WEEKDAY_COLUMNS.map((d) => (c[d] === '1' ? 1 : 0)),
    start: gtfsDate(c.start_date),
    end: gtfsDate(c.end_date),
  }));
  const exceptionEntries = rows(files['calendar_dates.txt']).map((e) => [e.service_id, gtfsDate(e.date), e.exception_type === '1' ? 1 : 0]);

  const info = rows(files['feed_info.txt'])[0];
  let feedEnd = info?.feed_end_date ? gtfsDate(info.feed_end_date) : '';
  if (!feedEnd) for (const c of calendarEntries) if (c.end > feedEnd) feedEnd = c.end;

  // Which stop_times rows are at each stop.
  const rowsAtStop = Array.from({ length: stops.length }, () => []);
  const tripOfRow = new Int32Array(count);
  for (let t = 0; t < trips.length; t++) {
    for (let i = stStart[t]; i < stStart[t + 1]; i++) {
      rowsAtStop[stStop[i]].push(i);
      tripOfRow[i] = t;
    }
  }

  return assembleFeed({
    routes, routeList, stops, stopIndex, trips, tripIndex, stStart, stStop, stSeq, stArr, stDep, stFlags, tripOfRow, rowsAtStop, shapes,
    calendarEntries,
    exceptionEntries,
    feedEnd,
    feedVersion: info?.feed_version ?? '',
  });
}

function assembleFeed(tables) {
  const { calendarEntries, exceptionEntries } = tables;
  const exceptions = new Map();
  for (const [service, date, added] of exceptionEntries) {
    if (!exceptions.has(date)) exceptions.set(date, new Map());
    exceptions.get(date).set(service, Boolean(added));
  }
  const serviceCache = new Map();
  return {
    ...tables,
    /** The set of service ids running on a date. */
    activeServices(dateKey) {
      let set = serviceCache.get(dateKey);
      if (set) return set;
      set = new Set();
      const weekday = weekdayOf(dateKey);
      for (const c of calendarEntries) {
        if (c.days[weekday] && dateKey >= c.start && dateKey <= c.end) set.add(c.id);
      }
      for (const [id, added] of exceptions.get(dateKey) ?? []) {
        if (added) set.add(id);
        else set.delete(id);
      }
      serviceCache.set(dateKey, set);
      return set;
    },
  };
}

/** Douglas-Peucker on flat [lng, lat] pairs; `toleranceDeg` is in degrees of latitude. */
export function simplifyLine(points, toleranceDeg) {
  if (points.length <= 2) return points;
  const scale = Math.cos(((points[0][1] ?? 0) * Math.PI) / 180);
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = points[a][0] * scale;
    const ay = points[a][1];
    const dx = points[b][0] * scale - ax;
    const dy = points[b][1] - ay;
    const lengthSq = dx * dx + dy * dy;
    let worst = -1;
    let worstAt = -1;
    for (let i = a + 1; i < b; i++) {
      const px = points[i][0] * scale - ax;
      const py = points[i][1] - ay;
      const t = lengthSq ? Math.min(1, Math.max(0, (px * dx + py * dy) / lengthSq)) : 0;
      const distance = Math.hypot(px - t * dx, py - t * dy);
      if (distance > worst) {
        worst = distance;
        worstAt = i;
      }
    }
    if (worst > toleranceDeg) {
      keep[worstAt] = 1;
      stack.push([a, worstAt], [worstAt, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

export function shapeCoords(feed, shapeId) {
  const flat = feed.shapes.get(shapeId);
  if (!flat) return [];
  const out = [];
  for (let i = 0; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
}

// --- Shape slicing --------------------------------------------------------------------

const LNG_METERS = 81_500;
const LAT_METERS = 111_000;

/** Closest point to a stop on segment i of a flat [lng, lat, ...] line. */
function projectOnSegment(flat, i, stop) {
  const ax = flat[i * 2];
  const ay = flat[i * 2 + 1];
  const dx = (flat[i * 2 + 2] - ax) * LNG_METERS;
  const dy = (flat[i * 2 + 3] - ay) * LAT_METERS;
  const px = (stop.lng - ax) * LNG_METERS;
  const py = (stop.lat - ay) * LAT_METERS;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq ? Math.min(1, Math.max(0, (px * dx + py * dy) / lengthSq)) : 0;
  return { t, distance: Math.hypot(px - t * dx, py - t * dy) };
}

const lerp = (flat, i, t) => [flat[i * 2] + (flat[i * 2 + 2] - flat[i * 2]) * t, flat[i * 2 + 1] + (flat[i * 2 + 3] - flat[i * 2 + 1]) * t];

/**
 * Cuts a trip's shape between two of its stops. Stops are matched in order, always
 * moving forward along the line, so a route that doubles back still slices correctly.
 */
export function shapeBetween(feed, tripIndex, boardPos, alightPos) {
  const trip = feed.trips[tripIndex];
  const flat = feed.shapes.get(trip.shapeId);
  const start = feed.stStart[tripIndex];
  const stopAt = (pos) => feed.stops[feed.stStop[start + pos]];
  if (!flat || flat.length < 4) {
    const line = [];
    for (let p = boardPos; p <= alightPos; p++) line.push([stopAt(p).lng, stopAt(p).lat]);
    return line;
  }
  const segments = flat.length / 2 - 1;
  let cursor = 0;
  let board = null;
  let alight = null;
  for (let p = 0; p <= alightPos; p++) {
    const stop = stopAt(p);
    let best = { segment: cursor, t: 0, distance: Infinity };
    for (let i = cursor; i < segments; i++) {
      const { t, distance } = projectOnSegment(flat, i, stop);
      if (distance < best.distance) best = { segment: i, t, distance };
      else if (best.distance < 40 && distance > best.distance + 250) break; // Passed it.
    }
    cursor = best.segment;
    if (p === boardPos) board = best;
    if (p === alightPos) alight = best;
  }
  const line = [lerp(flat, board.segment, board.t)];
  for (let i = board.segment + 1; i <= alight.segment; i++) line.push([flat[i * 2], flat[i * 2 + 1]]);
  line.push(lerp(flat, alight.segment, alight.t));
  return line;
}

// --- Compact form, for sending to a browser -----------------------------------------------

const SHAPE_TOLERANCE_DEG = 0.00003; // About 3 m.
const SHAPE_SCALE = 1e5;

/**
 * Trips sharing a stop sequence become one "pattern", and trips with the same run times
 * share a time profile, so each trip is little more than its start time.
 * `stops` must be the stop list the site will rebuild from (the overview's).
 */
export function compactFeed(feed, stops) {
  const stopPosition = new Map(stops.map((s, i) => [s.id, i]));
  const services = [];
  const serviceIndex = new Map();
  const headsigns = [];
  const headsignIndex = new Map();
  const shapeIds = [...new Set(feed.trips.map((t) => t.shapeId))].filter((id) => feed.shapes.has(id));
  const shapeIndex = new Map(shapeIds.map((id, i) => [id, i]));
  const intern = (list, index, value) => {
    let i = index.get(value);
    if (i === undefined) {
      i = list.length;
      index.set(value, i);
      list.push(value);
    }
    return i;
  };

  const patterns = new Map();
  feed.trips.forEach((trip, t) => {
    const a = feed.stStart[t];
    const b = feed.stStart[t + 1];
    const stopList = Array.from(feed.stStop.subarray(a, b), (i) => stopPosition.get(feed.stops[i].id));
    const sequences = Array.from(feed.stSeq.subarray(a, b));
    const flags = Array.from(feed.stFlags.subarray(a, b));
    const key = `${trip.routeId}|${trip.direction}|${trip.shapeId}|${stopList.join()}|${sequences.join()}|${flags.join()}`;
    let pattern = patterns.get(key);
    if (!pattern) {
      const plainSequence = sequences.every((s, i) => s === i + 1);
      pattern = {
        r: trip.routeId,
        d: trip.direction,
        s: shapeIndex.get(trip.shapeId) ?? -1,
        st: stopList,
        ...(plainSequence ? {} : { sq: sequences }),
        ...(flags.some(Boolean) ? { f: flags } : {}),
        p: [],
        t: [],
        profileIndex: new Map(),
      };
      patterns.set(key, pattern);
    }
    const startTime = feed.stDep[a];
    const profile = [];
    for (let i = a; i < b; i++) profile.push(feed.stArr[i] - startTime, feed.stDep[i] - startTime);
    const profileKey = profile.join();
    let profileAt = pattern.profileIndex.get(profileKey);
    if (profileAt === undefined) {
      profileAt = pattern.p.length;
      pattern.profileIndex.set(profileKey, profileAt);
      pattern.p.push(profile);
    }
    const service = intern(services, serviceIndex, trip.serviceId);
    const suffix = `-${trip.serviceId}`;
    // Trip ids are "<number>-<service>" here, so usually only the number needs storing.
    const shortId = trip.id.endsWith(suffix) ? trip.id.slice(0, -suffix.length) : `=${trip.id}`;
    pattern.t.push([startTime, profileAt, service, intern(headsigns, headsignIndex, trip.headsign), shortId]);
  });

  return {
    services,
    calendar: feed.calendarEntries,
    exceptions: feed.exceptionEntries,
    headsigns,
    shapes: shapeIds.map((id) => {
      const flat = feed.shapes.get(id);
      const points = [];
      for (let i = 0; i < flat.length; i += 2) points.push([flat[i], flat[i + 1]]);
      const out = [];
      let x = 0;
      let y = 0;
      for (const [lng, lat] of simplifyLine(points, SHAPE_TOLERANCE_DEG)) {
        const nx = Math.round(lng * SHAPE_SCALE);
        const ny = Math.round(lat * SHAPE_SCALE);
        out.push(nx - x, ny - y);
        x = nx;
        y = ny;
      }
      return out;
    }),
    shapeIds,
    patterns: [...patterns.values()].map(({ profileIndex: _unused, ...rest }) => rest),
  };
}

/** Rebuilds the tables from compactFeed's output and the overview's routes and stops. */
export function feedFromCompact(overview, compact) {
  const routeList = overview.routes.map((r) => ({ ...r, desc: r.desc ?? '' }));
  const routes = new Map(routeList.map((r) => [r.id, r]));
  const stops = overview.stops.map(({ id, code, name, lat, lng }) => ({ id, code, name, lat, lng }));
  const stopIndex = new Map(stops.map((s, i) => [s.id, i]));

  let tripCount = 0;
  let rowCount = 0;
  for (const p of compact.patterns) {
    tripCount += p.t.length;
    rowCount += p.t.length * p.st.length;
  }
  const stStart = new Int32Array(tripCount + 1);
  const stStop = new Int32Array(rowCount);
  const stSeq = new Int32Array(rowCount);
  const stArr = new Int32Array(rowCount);
  const stDep = new Int32Array(rowCount);
  const stFlags = new Uint8Array(rowCount);
  const tripOfRow = new Int32Array(rowCount);
  const rowsAtStop = stops.map(() => []);
  const trips = [];
  const tripIndex = new Map();
  let row = 0;
  for (const p of compact.patterns) {
    const shapeId = p.s >= 0 ? compact.shapeIds[p.s] : '';
    for (const [startTime, profileAt, service, headsign, shortId] of p.t) {
      const t = trips.length;
      const serviceId = compact.services[service];
      const id = String(shortId).startsWith('=') ? String(shortId).slice(1) : `${shortId}-${serviceId}`;
      tripIndex.set(id, t);
      trips.push({ id, routeId: p.r, serviceId, headsign: compact.headsigns[headsign], direction: p.d, shapeId });
      const profile = p.p[profileAt];
      stStart[t] = row;
      for (let i = 0; i < p.st.length; i++) {
        stStop[row] = p.st[i];
        stSeq[row] = p.sq ? p.sq[i] : i + 1;
        stArr[row] = startTime + profile[i * 2];
        stDep[row] = startTime + profile[i * 2 + 1];
        stFlags[row] = p.f ? p.f[i] : 0;
        tripOfRow[row] = t;
        rowsAtStop[p.st[i]].push(row);
        row++;
      }
    }
  }
  stStart[tripCount] = row;

  const shapes = new Map();
  compact.shapes.forEach((deltas, i) => {
    const flat = new Float64Array(deltas.length);
    let x = 0;
    let y = 0;
    for (let j = 0; j < deltas.length; j += 2) {
      x += deltas[j];
      y += deltas[j + 1];
      flat[j] = x / SHAPE_SCALE;
      flat[j + 1] = y / SHAPE_SCALE;
    }
    shapes.set(compact.shapeIds[i], flat);
  });

  return assembleFeed({
    routes, routeList, stops, stopIndex, trips, tripIndex, stStart, stStop, stSeq, stArr, stDep, stFlags, tripOfRow, rowsAtStop, shapes,
    calendarEntries: compact.calendar,
    exceptionEntries: compact.exceptions,
    feedEnd: overview.feed.end,
    feedVersion: overview.feed.version,
  });
}
