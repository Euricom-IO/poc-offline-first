/**
 * Fault-injection dev proxy — configuration.
 *
 * The proxy sits between a frontend and the API (`@app/api`) so a test can make
 * the "network" misbehave on demand: answer with 500s, stall a request, drop
 * the connection, or take the whole listener down. Everything it does not fault
 * is forwarded verbatim.
 *
 * Two listeners, on purpose:
 *
 *   :3100  data plane    — forwards to the API, and is what faults apply to
 *   :3101  control plane — arms/disarms faults; stays up when :3100 is taken down
 */

/** Port the forwarding proxy listens on (3000 is the API, 3001 is often taken locally). */
export const PROXY_PORT = Number(process.env.PROXY_PORT ?? 3100);

/** Port the control plane listens on. Separate so it survives `POST /down`. */
export const PROXY_CONTROL_PORT = Number(process.env.PROXY_CONTROL_PORT ?? 3101);

/** Upstream the proxy forwards to — the Hono API. */
export const PROXY_TARGET = (process.env.PROXY_TARGET ?? 'http://localhost:3000').replace(/\/+$/, '');

/**
 * Second upstream: the PowerSync service, which the browser streams its
 * downloads from. Requests under {@link POWERSYNC_PREFIX} are forwarded here
 * with the prefix stripped, so `POST :3100/powersync/sync/stream` becomes
 * `POST :8080/sync/stream` and the same faults apply to both legs.
 */
export const POWERSYNC_TARGET = (process.env.POWERSYNC_TARGET ?? 'http://localhost:8080').replace(
  /\/+$/,
  '',
);

/** Path prefix that marks a request as belonging to the PowerSync service. */
export const POWERSYNC_PREFIX = '/powersync';

/**
 * Path prefix the control plane also answers on from the data-plane port, so
 * `:3100/__proxy/...` keeps working while the proxy is up. Requests under it
 * are handled by the proxy itself and are never forwarded or faulted.
 */
export const CONTROL_PREFIX = '/__proxy';
