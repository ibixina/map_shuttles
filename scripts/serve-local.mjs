// Runs the built site as GitHub Pages will: static files only, under a sub-path, with the
// live relay as a separate service on another port. Set NO_LIVE=1 to leave the relay off.
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandler } from '../worker/live-proxy.mjs';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const SITE_PORT = Number(process.env.PORT ?? 4173);
const LIVE_PORT = Number(process.env.LIVE_PORT ?? 8787);
const SUB_PATH = process.env.SUB_PATH ?? '/shuttle-map';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/' || path === SUB_PATH) {
    res.writeHead(302, { location: `${SUB_PATH}/` }).end();
    return;
  }
  if (!path.startsWith(`${SUB_PATH}/`)) {
    res.writeHead(404).end('Not found');
    return;
  }
  const relative = decodeURIComponent(path.slice(SUB_PATH.length + 1)) || 'index.html';
  const file = normalize(join(DIST, relative));
  try {
    if (!file.startsWith(DIST + sep) || !statSync(file).isFile()) throw new Error('missing');
  } catch {
    res.writeHead(404).end('Not found'); // Like Pages: no fallback to index.html.
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}).listen(SITE_PORT, () => console.log(`Site: http://localhost:${SITE_PORT}${SUB_PATH}/`));

if (!process.env.NO_LIVE) {
  const handle = createHandler();
  createServer(async (req, res) => {
    const response = await handle(new Request(`http://localhost:${LIVE_PORT}${req.url}`, { method: req.method, headers: req.headers }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  }).listen(LIVE_PORT, () => console.log(`Live relay: http://localhost:${LIVE_PORT}`));
}
