import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createHandler } from './worker/live-proxy.mjs';

/** In development, serves the live relay at /live on the same server. */
function liveRelay(): Plugin {
  const handle = createHandler();
  return {
    name: 'live-relay',
    configureServer(server) {
      server.middlewares.use('/live', (req, res, next) => {
        handle(new Request(`http://localhost${req.url}`, { method: req.method }))
          .then(async (response) => {
            res.statusCode = response.status;
            response.headers.forEach((value, key) => res.setHeader(key, value));
            res.end(Buffer.from(await response.arrayBuffer()));
          })
          .catch(next);
      });
    },
  };
}

export default defineConfig({
  // Relative, so the site works at any sub-path such as username.github.io/repo/.
  base: './',
  plugins: [react(), liveRelay()],
  worker: { format: 'es' },
  test: { include: ['tests/*.test.ts'] },
} as never);
