// Browser smoke test against a running app with the real upstream services.
//   PLAYWRIGHT_PATH=/path/to/playwright/index.mjs node tests/e2e/smoke.mjs [baseUrl] [screenshotDir]
const { chromium } = await import(process.env.PLAYWRIGHT_PATH ?? 'playwright');

const BASE = (process.argv[2] ?? 'http://localhost:4173/shuttle-map').replace(/\/$/, '');
const OUT = process.argv[3] ?? '.';
const ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'];

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures.push(name);
};

const browser = await chromium.launch({ args: ARGS });

async function open(viewport, path = '/', options = {}) {
  const context = await browser.newContext({ viewport, ...options });
  const page = await context.newPage();
  page.problems = [];
  page.on('pageerror', (e) => page.problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) page.problems.push(`console: ${m.text()}`);
  });
  await page.goto(BASE + path, { waitUntil: 'load' });
  await page.waitForSelector('.app[data-ready="yes"]', { timeout: 20_000 });
  return page;
}
const settle = (page, ms = 2500) => page.waitForTimeout(ms);
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png` });

async function search(page, label, query) {
  const input = page.getByRole('combobox', { name: label });
  await input.click();
  await input.fill(query);
  await page.waitForSelector('.searchbox-results li', { timeout: 8_000 });
}

async function openQuick(page, label) {
  await page.getByRole('combobox', { name: 'Search for a place' }).click();
  await page.locator('.searchbox-results button', { hasText: label }).first().click();
}

// ---- Desktop -------------------------------------------------------------------------
const desk = await open({ width: 1280, height: 800 });
await settle(desk, 4000);
check('map canvas rendered', (await desk.locator('canvas.maplibregl-canvas').count()) === 1);
check('resting state is just the map and search', (await desk.locator('.panel').count()) === 0);
check('shuttle buses on the map', (await desk.locator('.bus-marker').count()) > 0);
await shot(desk, '01-home');

// A real mouse click on a bus marker opens that bus, with its driver and vehicle details.
const marker = await desk.locator('.bus-marker').first().boundingBox();
await desk.mouse.click(marker.x + marker.width / 2, marker.y + marker.height / 2);
await desk.waitForSelector('.bus-details', { timeout: 5_000 }).catch(() => undefined);
check('clicking a bus opens its panel', desk.url().includes('bus='), desk.url());
const busText = await desk.locator('.panel').innerText();
check('bus panel shows vehicle details', /License plate/.test(busText) && /VIN/.test(busText));
await settle(desk, 800);
await shot(desk, '01b-bus');
await desk.goto(`${BASE}/`);
await desk.waitForSelector('.app[data-ready="yes"]');
await settle(desk, 2500);

await search(desk, 'Search for a place', 'DCC');
check('abbreviation search', (await desk.locator('.searchbox-results li').first().innerText()).includes('Darrin Communications Center'));
await shot(desk, '02-search');
await desk.locator('.searchbox-results li button').first().click();
await settle(desk);
await desk.waitForSelector('.trip-card', { timeout: 15_000 });
await settle(desk, 3000);
check('picking a place goes straight to the ways to get there', (await desk.locator('.destination h2').innerText()).includes('Darrin'));
check('pin on map', (await desk.locator('.map-pin').count()) === 1);
check('starts from the Student Union by default', (await desk.getByRole('combobox', { name: 'Starting point' }).inputValue()) === 'Student Union');
check('URL is shareable', desk.url().includes('to='));
await shot(desk, '03-place');

await search(desk, 'Starting point', 'City Station');
await desk.locator('.searchbox-results li button').first().click();
await settle(desk, 2000);
await desk.waitForSelector('.trip-card', { timeout: 10_000 });
await settle(desk, 3000);
const cards = await desk.locator('.trip-card').count();
check('several ways to get there', cards >= 2, `${cards} cards`);
check('first option selected', (await desk.locator('.trip-card.is-selected').count()) === 1);
check('best option labeled', (await desk.locator('.trip-card').first().innerText()).includes('Best'));
check('steps shown', (await desk.locator('.steps .step').count()) >= 1);
const busCard = desk.locator('.trip-card', { hasText: 'Get on' }).first();
check('a bus option says where to get on and off', /Get on[\s\S]*Get off/.test(await busCard.innerText()));
await shot(desk, '04-directions');

await busCard.click();
await settle(desk, 1500);
const steps = await desk.locator('.steps').innerText();
check('bus steps name the stop', /Board (the (North|West) Route|CDTA \w+) at/.test(steps));
check('bus steps say when', /\d:\d\d [AP]M/.test(steps));
check('only the chosen option is expanded', (await desk.locator('.steps').count()) === 1);
check('steps sit inside the chosen option', (await desk.locator('.trip-option.is-selected .steps').count()) === 1);
await shot(desk, '05-directions-shuttle');

await desk.reload();
await desk.waitForSelector('.trip-card', { timeout: 15_000 });
check('directions survive reload', (await desk.locator('.trip-card').count()) >= 1);
await desk.getByRole('button', { name: 'Swap start and destination' }).click();
await desk.waitForTimeout(800);
check('swap works', (await desk.getByRole('combobox', { name: 'Starting point' }).inputValue()).includes('Darrin'));
await desk.goBack();
await settle(desk, 500);
check('back undoes swap', (await desk.getByRole('combobox', { name: 'Destination' }).inputValue()).includes('Darrin'));

await desk.goto(`${BASE}/`);
await desk.waitForSelector('.app[data-ready="yes"]');
await openQuick(desk, 'North Route');
await settle(desk);
check('route panel lists 10 stops', (await desk.locator('.timeline li').count()) === 10);
await shot(desk, '06-route');
await desk.locator('.timeline button').nth(3).click();
await settle(desk);
check('stop panel from route', (await desk.locator('.panel-heading p').innerText()).startsWith('Shuttle stop'));
await shot(desk, '07-stop');

await desk.goto(`${BASE}/`);
await desk.waitForSelector('.app[data-ready="yes"]');
await openQuick(desk, 'Food');
await settle(desk);
check('browse lists food', (await desk.locator('.panel-body li').count()) > 20);
await shot(desk, '08-browse');

await desk.goto(`${BASE}/`);
await desk.waitForSelector('.app[data-ready="yes"]');
await search(desk, 'Search for a place', 'Hoosick Street');
await settle(desk, 1500);
check('address search through the geocoder', (await desk.locator('.searchbox-results').innerText()).length > 0);
await shot(desk, '09-address-search');

await desk.goto(`${BASE}/`);
await desk.waitForSelector('.app[data-ready="yes"]');
await settle(desk, 2500);
await desk.mouse.click(900, 300);
await settle(desk, 2000);
check('clicking the map plans a trip there', desk.url().includes('to=') || desk.url().includes('stop='), desk.url());
await shot(desk, '10-map-click');

await desk.getByRole('button', { name: 'Map layers' }).click();
await desk.getByRole('checkbox', { name: 'Satellite' }).check();
await desk.mouse.click(700, 760);
await settle(desk, 3500);
await shot(desk, '11-satellite');

check('no script errors on desktop', desk.problems.length === 0, desk.problems.slice(0, 3).join(' | '));

// ---- Location ------------------------------------------------------------------------
const located = await open({ width: 1280, height: 800 }, '/', {
  geolocation: { latitude: 42.7276, longitude: -73.6878 },
  permissions: ['geolocation'],
});
await located.getByRole('button', { name: 'Show my location' }).click();
await located.waitForSelector('.map-me', { timeout: 20_000 }).catch(() => undefined);
check('location dot', (await located.locator('.map-me').count()) === 1, located.problems[0] ?? '');
await located.context().close();

// A device that can't locate itself: retries more forgivingly, then offers a way forward.
{
  const DIRECTIONS_FROM_UNION = '/?place=42.730300,-73.688700,Sushi%20King';
  const stub = (failCount) => `
    let calls = 0;
    navigator.geolocation.getCurrentPosition = (ok, fail, options) => {
      window.__firstLocationOptions ??= options;
      calls += 1;
      if (calls <= ${failCount}) fail({ code: 2, message: 'unavailable' });
      else ok({ coords: { latitude: 42.7276, longitude: -73.6878 } });
    };
    navigator.geolocation.watchPosition = () => 1;
  `;
  const retried = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await retried.addInitScript(stub(1));
  let page = await retried.newPage();
  await page.goto(BASE + DIRECTIONS_FROM_UNION);
  await page.waitForSelector('.trip-card', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Use my location' }).click();
  await page.waitForFunction(() => document.querySelector('input[aria-label="Starting point"]')?.value === 'Your location', null, { timeout: 5_000 }).catch(() => undefined);
  check('location: a second, gentler attempt can succeed', (await page.getByRole('combobox', { name: 'Starting point' }).inputValue()) === 'Your location');
  await retried.close();

  const failing = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await failing.addInitScript(stub(99));
  page = await failing.newPage();
  await page.goto(BASE + DIRECTIONS_FROM_UNION);
  await page.waitForSelector('.trip-card', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Use my location' }).click();
  await page.waitForFunction(() => /Couldn't get your location/.test(document.querySelector('.panel')?.textContent ?? ''), null, { timeout: 5_000 });
  check('location: says why, and keeps the trip list', (await page.locator('.trip-card').count()) > 0);
  check('location: asks for the ordinary fix first', await page.evaluate(() => window.__firstLocationOptions?.enableHighAccuracy === false));
  await shot(page, '41-location-failed');
  await page.getByRole('button', { name: 'click your spot on the map' }).click();
  await page.waitForFunction(() => document.querySelector('input[aria-label="Starting point"]')?.value === '', null, { timeout: 5_000 });
  await settle(page, 1200);
  await page.mouse.click(900, 300);
  await page.waitForSelector('.trip-card', { timeout: 30_000 });
  check('location: clicking the map sets the start', (await page.getByRole('combobox', { name: 'Starting point' }).inputValue()).length > 0);
  await failing.close();
}

// ---- Phone ----------------------------------------------------------------------------
const phone = await open({ width: 390, height: 844 }, '/', { deviceScaleFactor: 2, hasTouch: true, isMobile: true });
await settle(phone, 4000);
const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
check('no sideways scroll on phone', !overflow);
await shot(phone, '20-phone-home');
await search(phone, 'Search for a place', 'folsom');
await shot(phone, '21-phone-search');
await phone.locator('.searchbox-results li button').first().tap();
await phone.waitForSelector('.trip-card', { timeout: 15_000 });
await settle(phone, 3000);
await shot(phone, '23-phone-directions');
await phone.getByRole('button', { name: 'Show more details' }).tap();
await settle(phone, 600);
await shot(phone, '24-phone-directions-expanded');
check('no script errors on phone', phone.problems.length === 0, phone.problems.slice(0, 3).join(' | '));

// ---- CDTA ---------------------------------------------------------------------------------
{
  const page = await open({ width: 1280, height: 800 });
  await page.waitForSelector('.cdta-marker', { timeout: 40_000 });
  await settle(page, 2500);
  check('CDTA buses on the map', (await page.locator('.cdta-marker').count()) > 0, `${await page.locator('.cdta-marker').count()} buses`);
  check('no paratransit buses on the map', !(await page.locator('.cdta-marker[data-bus="93"]').count()));
  await shot(page, '50-cdta-home');

  await search(page, 'Search for a place', '87');
  check('search finds a route by number', (await page.locator('.searchbox-results li').first().innerText()).includes('CDTA 87'));
  await page.locator('.searchbox-results li button').first().click();
  await page.waitForSelector('.timeline li', { timeout: 15_000 });
  await settle(page);
  check('route panel lists stops', (await page.locator('.timeline li').count()) > 10);
  check('route panel credits CDTA', (await page.locator('.panel').innerText()).includes('Bus data from CDTA'));
  await shot(page, '51-cdta-route');
  const tabs = page.locator('.segments button');
  if ((await tabs.count()) > 1) {
    const before = await page.locator('.timeline li').first().innerText();
    await tabs.nth(1).click();
    await settle(page, 800);
    check('direction switch changes the stops', before !== (await page.locator('.timeline li').first().innerText()));
  }
  await page.locator('.timeline button').nth(3).click();
  await page.waitForFunction(() => /Next buses/i.test(document.querySelector('.panel')?.textContent ?? ''), null, { timeout: 15_000 });
  await settle(page, 2000);
  check('CDTA stop panel', /CDTA stop/.test(await page.locator('.panel-heading p').innerText()));
  const stopName = await page.locator('.panel-heading h2').innerText();
  check('search box follows the open stop', (await page.getByRole('combobox', { name: 'Search for a place' }).inputValue()) === stopName);
  await shot(page, '52-cdta-stop');

  await page.goto(`${BASE}/`);
  await page.waitForSelector('.cdta-marker', { timeout: 30_000 });
  const pill = page.locator('.cdta-marker').first();
  await pill.dispatchEvent('click');
  await page.waitForFunction(() => location.search.includes('cbus='), null, { timeout: 5_000 });
  await page.waitForFunction(() => /Last update/.test(document.querySelector('.panel')?.textContent ?? ''), null, { timeout: 15_000 });
  await settle(page, 1500);
  check('clicking a CDTA bus opens it', /Bus \d+/.test(await page.locator('.panel-heading h2').innerText()));
  await shot(page, '53-cdta-bus');

  // A trip the shuttles can't do alone.
  await page.goto(`${BASE}/?directions=1&from=42.729900,-73.676600,Student%20Union&to=42.652600,-73.756200,Downtown%20Albany`);
  await page.waitForSelector('.trip-card .badge', { timeout: 40_000 });
  await settle(page, 3000);
  const cards = await page.locator('.trip-list').innerText();
  check('directions offer buses to Albany', (await page.locator('.trip-card .badge').count()) > 0, cards.replace(/\n/g, ' ').slice(0, 140));
  const steps = await page.locator('.steps').innerText();
  check('CDTA trip names the bus', /Board CDTA/.test(steps));
  const stepKinds = await page.locator('.steps .step').evaluateAll((els) => els.map((e) => (e.classList.contains('step-walk') ? 'walk' : 'ride')));
  check('no two walks in a row', !stepKinds.some((k, i) => k === 'walk' && stepKinds[i - 1] === 'walk'), stepKinds.join(' '));
  await shot(page, '54-cdta-directions');

  // The toggle hides CDTA and is remembered.
  await page.goto(`${BASE}/`);
  await page.waitForSelector('.cdta-marker', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Map layers' }).click();
  await page.getByRole('checkbox', { name: 'CDTA buses' }).uncheck();
  await settle(page, 600);
  check('toggle hides CDTA buses', (await page.locator('.cdta-marker').count()) === 0);
  await page.reload();
  await page.waitForSelector('.app[data-ready="yes"]', { timeout: 20_000 });
  await settle(page, 1500);
  check('toggle is remembered', (await page.locator('.cdta-marker').count()) === 0);
  check('no script errors with CDTA', page.problems.length === 0, page.problems.slice(0, 3).join(' | '));
  await page.context().close();
}

// Bad CDTA links, and the CDTA side being down.
{
  for (const path of ['/?cstop=NOPE', '/?croute=NOPE', '/?cbus=NOPE']) {
    const page = await open({ width: 800, height: 600 }, path);
    await page.waitForTimeout(1500);
    check(`bad link ${path}`, page.problems.length === 0 && (await page.locator('.sidebar input').count()) > 0, page.problems[0] ?? '');
    await page.context().close();
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.route(/data\/cdta-/, (r) => r.fulfill({ status: 404, body: '' }));
  const page = await context.newPage();
  await page.goto(`${BASE}/?directions=1&from=42.727673,-73.687228,City%20Station&to=42.731646,-73.666544,ECAV`);
  await page.waitForSelector('.trip-card', { timeout: 20_000 });
  check('CDTA data missing: shuttle directions still work', (await page.locator('.trip-card').count()) >= 1);
  await context.close();
}

// The whole point: pick somewhere downtown, and see every bus that goes near it.
{
  const page = await open({ width: 1280, height: 800 }, '/?place=42.730300,-73.688700,Sushi%20King');
  await page.waitForSelector('.trip-card .badge', { timeout: 40_000 });
  await settle(page, 3500);
  const routes = await page.locator('.trip-card .badge').allInnerTexts();
  check('lists shuttles and CDTA buses together', routes.includes('West') && routes.some((r) => /^\d+$/.test(r)), routes.join(' '));
  check('lists several routes', new Set(routes).size >= 3, routes.join(' '));
  await shot(page, '57-all-options');
  await page.context().close();
}

// Satellite up close, on a trip: sharp imagery, with readable names.
{
  const page = await open({ width: 1280, height: 800 }, '/?directions=1&from=42.729900,-73.676600,Student%20Union&to=42.729380,-73.682662,Folsom%20Library');
  await page.waitForSelector('.trip-card', { timeout: 30_000 });
  await settle(page, 3000);
  await shot(page, '58-trip-map');
  await page.getByRole('button', { name: 'Map layers' }).click();
  await page.getByRole('checkbox', { name: 'Satellite' }).check();
  await page.mouse.click(700, 780);
  await settle(page, 7000);
  await shot(page, '59-trip-satellite');
  check('no script errors with sharper imagery', page.problems.length === 0, page.problems[0] ?? '');
  await page.context().close();
}

// ---- A selected route has to stand out ---------------------------------------------------
{
  const page = await open({ width: 1280, height: 800 }, '/?croute=87');
  await page.waitForSelector('.timeline li', { timeout: 20_000 });
  await settle(page, 3000);
  // Sampled from the real pixels: the map behind the route fades, the route stays strong.
  check('other buses are hidden while a route is selected', (await page.locator('.bus-marker').count()) === 0);

  await shot(page, '55-focus-cdta');
  await page.goto(`${BASE}/?route=NORTH`);
  await page.waitForSelector('.timeline li', { timeout: 20_000 });
  await settle(page, 3000);
  await shot(page, '56-focus-shuttle');
  await page.context().close();
}

// ---- Failure modes and edge cases --------------------------------------------------------
const DIRECTIONS = '/?directions=1&from=42.727673,-73.687228,City%20Station&to=42.731646,-73.666544,ECAV';

// Walking-route services down: still plans, and says the times are rough.
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.route(/valhalla1\.openstreetmap\.de|routing\.openstreetmap\.de/, (r) => r.abort());
  const page = await context.newPage();
  await page.goto(BASE + DIRECTIONS);
  await page.waitForSelector('.trip-card', { timeout: 20_000 });
  await page.waitForTimeout(2500);
  const text = await page.locator('.panel').innerText();
  check('routers down: still gives trips', (await page.locator('.trip-card').count()) >= 1);
  check('routers down: says times are rough', /rough estimates/.test(text));
  await shot(page, '30-routers-down');
  await context.close();
}

// Live feed down: schedule still works, with a warning. Announcements appear as plain text.
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.route(/\/shuttle$/, (r) => r.fulfill({ status: 502, body: '{}' }));
  const page = await context.newPage();
  await page.goto(`${BASE}/?route=WEST`);
  await page.waitForSelector('.timeline li', { timeout: 20_000 });
  await page.waitForTimeout(1500);
  const text = await page.locator('.sidebar').innerText();
  check('live down: warns', /aren't updating/.test(text));
  check('live down: schedule still shown', /\d:\d\d [AP]M/.test(text));
  await shot(page, '31-live-down');
  await context.close();
}

// Announcements are shown as plain text, never as HTML.
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.route(/\/shuttle$/, (r) =>
    r.fulfill({ json: { locations: {}, velocities: {}, etas: {}, announcements: [{ id: 1, message: 'No service Monday <img src=x onerror=alert(1)>' }] } }));
  const page = await context.newPage();
  await page.goto(`${BASE}/`);
  await page.waitForSelector('.banner', { timeout: 20_000 });
  const text = await page.locator('.sidebar').innerText();
  check('announcement shown as text, not HTML', text.includes('<img src=x') && (await page.locator('.banner img').count()) === 0);
  await context.close();
}

// Shuttle API down entirely: says so instead of hanging.
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.route(/data\/shuttle-/, (r) => r.fulfill({ status: 404, body: '' }));
  const page = await context.newPage();
  await page.goto(`${BASE}/`);
  await page.waitForFunction(() => document.querySelector('.sidebar')?.textContent?.includes("Can't load"), null, { timeout: 15_000 });
  check('data missing: says so', true);
  await context.close();
}

// 2:30 AM on a Monday: no buses until morning.
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date('2026-11-02T07:30:00Z'));
  await page.goto(BASE + DIRECTIONS);
  await page.waitForSelector('.trip-card', { timeout: 20_000 });
  const text = await page.locator('.trip-list').innerText();
  check('overnight: offers a morning trip', /[67]:\d\d AM/.test(text), text.replace(/\n/g, ' ').slice(0, 120));
  await settle(page, 3000);
  await shot(page, '32-overnight');
  await context.close();
}

// Someone a long way away, heading somewhere else entirely.
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${BASE}/?directions=1&from=40.750000,-73.990000,New%20York&to=42.731646,-73.666544,ECAV`);
  await page.waitForFunction(() => /Neither the shuttle/.test(document.querySelector('.panel')?.textContent ?? ''), null, { timeout: 30_000 }).catch(() => undefined);
  check('out of range: explains', /Neither the shuttle nor CDTA/.test(await page.locator('.panel').innerText()));
  await settle(page, 3000);
  await shot(page, '33-out-of-range');
  await context.close();
}

// Keyboard only.
{
  const page = await open({ width: 1280, height: 800 });
  const input = page.getByRole('combobox', { name: 'Search for a place' });
  await input.focus();
  await page.keyboard.type('empac');
  await page.waitForSelector('.searchbox-results li');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.destination h2', { timeout: 15_000 });
  check('keyboard: search and choose', (await page.locator('.destination h2').innerText()).includes('EMPAC'));
  const destination = page.getByRole('combobox', { name: 'Destination' });
  await destination.focus();
  await page.keyboard.press('Escape');
  check('keyboard: escape keeps the place', (await destination.inputValue()).includes('EMPAC'));
}

// Selecting a trip stays selected as time passes; Leave At changes the times.
{
  const page = await open({ width: 1280, height: 800 }, DIRECTIONS);
  await page.waitForSelector('.trip-card', { timeout: 20_000 });
  await page.getByRole('combobox', { name: 'When to leave' }).selectOption('later');
  await page.getByRole('combobox', { name: 'Day' }).selectOption('1');
  await page.getByLabel('Time', { exact: true }).fill('10:00');
  await page.waitForFunction(() => /Tomorrow/.test(document.querySelector('.trip-list')?.textContent ?? ''), null, { timeout: 8_000 }).catch(() => undefined);
  check('leave at: uses the chosen time', /Tomorrow/.test(await page.locator('.trip-list').innerText()));
}

// Bad links shouldn't break anything.
{
  for (const path of ['/?stop=NOPE', '/?route=NOPE', '/?bus=NOPE', '/?place=garbage', '/?directions=1&from=abc&to=xyz', '/?browse=nonsense']) {
    const page = await open({ width: 800, height: 600 }, path);
    await page.waitForTimeout(300);
    check(`bad link ${path}`, page.problems.length === 0 && (await page.locator('.sidebar input').count()) > 0, page.problems[0] ?? '');
    await page.context().close();
  }
}

// A small phone.
{
  const small = await open({ width: 360, height: 640 }, '/?stop=WEST:STUDENT_UNION', { deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await settle(small, 2500);
  check('small phone: no sideways scroll', !(await small.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
  await shot(small, '40-small-phone-stop');
}

await browser.close();
console.log(failures.length ? `\n${failures.length} failed` : '\nAll passed');
process.exit(failures.length ? 1 : 0);
