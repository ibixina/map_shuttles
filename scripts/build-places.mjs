// Regenerates src/data/places.json from OpenStreetMap (ODbL).
// Run by hand with `npm run places`; the output is committed so the app never
// depends on Overpass at runtime.
import { writeFileSync } from 'node:fs';

const BBOX = '42.722,-73.692,42.742,-73.660';
const RPI_AREA = 3600000000 + 8670722; // OSM relation "Rensselaer Polytechnic Institute"
const OVERPASS = 'https://overpass-api.de/api/interpreter';

// Names people actually say, mapped to the exact OSM name.
const ALIASES = {
  'Rensselaer Student Union': ['union', 'student union', 'the union', 'rsu'],
  'Darrin Communications Center': ['dcc', 'darrin'],
  'Center for Biotechnology and Interdisciplinary Studies': ['cbis', 'biotech'],
  'Experimental Media and Performing Arts Center (EMPAC)': ['empac', 'curtis priem'],
  'Voorhees Computing Center': ['vcc', 'voorhees'],
  'J Erik Jonsson Engineering Center': ['jec', 'jonsson engineering'],
  'Jonsson-Rowland Science Center': ['jrsc', 'jrowl', 'j-rowl', 'science center'],
  'Materials Research Center': ['mrc'],
  'Low Center For Industrial Innovation': ['cii', 'low center', 'low'],
  'Russell Sage Laboratory': ['sage', 'sage lab', 'sage labs'],
  'Russell Sage Dining Hall': ['rsdh', 'sage dining', 'sage dining hall'],
  'Commons Dining Hall': ['commons', 'the commons'],
  'Burdett Avenue Residence Hall': ['barh'],
  'East Campus Athletic Village Arena & Stadium': ['ecav', 'east campus athletic village', 'stadium', 'arena'],
  'Alumni Sports And Recreation Center': ['armory', 'the armory', 'asrc', 'rec center'],
  "'87 Gymnasium": ['87 gym', 'gym'],
  'Folsom Library': ['library', 'folsom', 'the library'],
  'Quadrangle Complex': ['quad', 'the quad'],
  'Mueller Center': ['mueller', 'fitness center'],
  'RPI Student Health Center': ['health center', 'student health', 'clinic'],
  'RPI Public Safety': ['public safety', 'campus police', 'campus security'],
  'Rensselaer Collegiate Store': ['bookstore', 'campus store'],
  'RPI Playhouse': ['playhouse'],
  'Houston Field House': ['hfh', 'field house', 'hockey'],
  'Rensselaer Polytechnic Institute': ['rpi', 'campus', 'rensselaer'],
  'Polytechnic Residence Commons': ['poly', 'polytech'],
  'Blitman Residence Commons (RPI)': ['blitman', 'blitman commons'],
  'Admissions': ['admissions office', 'visitor center'],
  'RPI International Services for Students and Scholars (ISSS)': ['isss', 'international services'],
  'Troy Savings Bank Music Hall': ['music hall'],
  'Uncle Sam Memorial': ['uncle sam'],
};

// Names that are not useful destinations.
const SKIP = /^(Church VI|Courtyard|Service Building|Parking Garage|H Building|EC4)$/;
// Well-known enough to want an alias, but not part of campus.
const OFF_CAMPUS = new Set(['Troy Savings Bank Music Hall', 'Uncle Sam Memorial']);
// Real places, but too minor or too interior to deserve a permanent map label.
const NO_LABEL = /^(ChargePoint|Bank of America|Broadview Federal Credit Union|Studio |EMPAC (Concert Hall|Theater)|RPI Campus Locksmith|RPI Auxiliary Services|RAHP )/;
const KEEP_KEYS = ['building', 'amenity', 'leisure', 'tourism', 'shop', 'office'];

// Overpass rate-limits per client, so queries run one at a time with retries.
async function overpass(query, attempts = 4) {
  const res = await fetch(OVERPASS, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'shuttle-map places build' },
    body: new URLSearchParams({ data: query }),
  });
  if (res.ok) return (await res.json()).elements;
  if (attempts <= 1) throw new Error(`Overpass ${res.status}`);
  await new Promise((r) => setTimeout(r, 15_000));
  return overpass(query, attempts - 1);
}

function category(t, name) {
  const a = t.amenity, b = t.building;
  if (['restaurant', 'cafe', 'fast_food', 'bar', 'pub', 'food_court', 'ice_cream'].includes(a) || /dining/i.test(name)) return 'food';
  if (a === 'parking' || /parking|garage$/i.test(name) || b === 'garage' || b === 'garages') return 'parking';
  if (t.leisure || /\bgym|field house|\bpool\b|athletic|recreation center|mueller/i.test(name)) return 'athletics';
  if (['dormitory', 'apartments', 'residential', 'house'].includes(b) || /residence|fraternity|sorority|apartment|rahp|commons$/i.test(name)) return 'housing';
  if (b === 'university' || ['university', 'college', 'school', 'library'].includes(a)) return 'academic';
  return 'other';
}

function address(t) {
  const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
  return [street, t['addr:city']].filter(Boolean).join(', ') || undefined;
}

const all = await overpass(`[out:json][timeout:60];(${KEEP_KEYS.map((k) => `nwr["name"]["${k}"](${BBOX});`).join('')});out center tags;`);
const campusIds = await overpass(`[out:json][timeout:60];area(id:${RPI_AREA})->.a;(nwr["name"](area.a););out ids;`);
const campusRoot = await overpass(`[out:json][timeout:60];relation(8670722);out center tags;`);
const inCampus = new Set(campusIds.map((e) => `${e.type}/${e.id}`));

const places = [];
for (const e of [...all, ...campusRoot]) {
  const t = e.tags ?? {};
  const name = t.name?.trim();
  const lat = e.lat ?? e.center?.lat;
  const lng = e.lon ?? e.center?.lon;
  if (!name || lat == null || lng == null || SKIP.test(name)) continue;
  const campus = !OFF_CAMPUS.has(name) && (inCampus.has(`${e.type}/${e.id}`) || Boolean(ALIASES[name])) || /\bRPI\b/.test(name) || /^Rensselaer (Student|Society|Collegiate|Polytechnic)/.test(name);
  const cat = category(t, name);
  const place = { name, lat: +lat.toFixed(6), lng: +lng.toFixed(6), cat, campus };
  const addr = address(t);
  if (addr) place.addr = addr;
  if (ALIASES[name]) place.aliases = ALIASES[name];
  // Only proper campus destinations get a permanent label on the map.
  if (campus && cat !== 'parking' && !NO_LABEL.test(name) && name !== 'Rensselaer Polytechnic Institute') place.label = true;
  places.push(place);
}

// OSM often has one name on several adjoining shapes; keep one per ~200 m.
const deduped = [];
for (const p of places.sort((a, b) => Number(b.campus) - Number(a.campus) || a.name.localeCompare(b.name))) {
  const dup = deduped.find((q) => q.name === p.name && Math.hypot(q.lat - p.lat, (q.lng - p.lng) * 0.73) < 0.002);
  if (!dup) deduped.push(p);
}

const missing = Object.keys(ALIASES).filter((n) => !deduped.some((p) => p.name === n));
if (missing.length) console.warn('Aliases with no OSM match:', missing);

writeFileSync(new URL('../src/data/places.json', import.meta.url), JSON.stringify(deduped, null, 0) + '\n');
console.log(`${deduped.length} places, ${deduped.filter((p) => p.campus).length} on campus, ${deduped.filter((p) => p.label).length} labelled`);
