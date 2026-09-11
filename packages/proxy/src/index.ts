import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { CONTROL_PREFIX, PROXY_CONTROL_PORT, PROXY_PORT, PROXY_TARGET } from './config';
import { proxyHandler } from './proxy';
import { createControlRoutes } from './routes/control';
import { serveControlPlane, serveDataPlane } from './server';

/**
 * Fault-injection dev proxy.
 *
 *   web-powersync (vite :5175) → proxy :3100 → api :3000
 *                                     ↑
 *                         control plane :3101 (always up)
 *
 * Everything is forwarded verbatim until a fault is armed: the proxy can then
 * answer 500s, stall a request for up to 30s, hang, drop a connection, or stop
 * listening altogether. Only writes are affected by default (`methods:
 * ["POST"]`), so reads and the PowerSync token endpoint keep working.
 */

// Data plane: control routes first (never forwarded, never faulted), then the
// catch-all forwarder.
const dataApp = new Hono();
dataApp.use('*', cors());
dataApp.route(CONTROL_PREFIX, createControlRoutes('data'));
// Anything else under the prefix is a typo, not traffic for the API: answer it
// here rather than forwarding `/__proxy/…` upstream.
dataApp.all(`${CONTROL_PREFIX}/*`, (c) =>
  c.json(
    {
      error: `unknown control route — see http://localhost:${PROXY_CONTROL_PORT}/`,
      dashboard: `http://localhost:${PROXY_CONTROL_PORT}/ui`,
    },
    404,
  ),
);
dataApp.all('*', proxyHandler);

// Control plane: the same routes at the root and under /__proxy, so both
// `:3101/fault` and `:3101/__proxy/fault` work.
const controlApp = new Hono();
controlApp.use('*', cors());
controlApp.route('/', createControlRoutes('control'));
controlApp.route(CONTROL_PREFIX, createControlRoutes('control'));
controlApp.all('*', (c) =>
  c.json({ error: 'control plane: see GET / for the endpoints it exposes' }, 404),
);

serveDataPlane(dataApp.fetch);
serveControlPlane(controlApp.fetch);

console.log(`🔀 Proxy listening on http://localhost:${PROXY_PORT} → ${PROXY_TARGET}`);
console.log(`🎛️  Control plane on http://localhost:${PROXY_CONTROL_PORT} (stays up when the proxy is down)`);
console.log(`📊 Dashboard    on http://localhost:${PROXY_CONTROL_PORT}/ui`);
