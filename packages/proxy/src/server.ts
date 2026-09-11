import { PROXY_CONTROL_PORT, PROXY_PORT } from './config';

/**
 * Listener lifecycle.
 *
 * The data plane can be stopped and restarted at runtime so a client sees a
 * genuinely unreachable server — `ECONNREFUSED` before any HTTP exchange
 * happens — which is a different failure from any status code the proxy could
 * answer with. That is only workable because the control plane listens on its
 * own port and therefore survives the shutdown.
 */

export type FetchHandler = (request: Request) => Response | Promise<Response>;

export interface DataPlaneStatus {
  port: number;
  listening: boolean;
  /** When it was taken down, or `null` while it is up. */
  downSince: string | null;
  /** When the auto-restore timer will bring it back, if one is running. */
  restoresAt: string | null;
}

/** What `Bun.serve` hands back — inferred so the WebSocket type parameter stays out of this. */
type ProxyServer = ReturnType<typeof Bun.serve>;

interface Plane {
  server: ProxyServer | null;
  handler: FetchHandler | null;
  downSince: string | null;
  restoresAt: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}

function emptyPlane(): Plane {
  return { server: null, handler: null, downSince: null, restoresAt: null, timer: null };
}

// `bun --hot` re-evaluates this module on every save. Parking the listeners on
// globalThis means a reload swaps the request handler instead of trying to bind
// ports that are already taken — and a data plane you deliberately took down
// stays down across reloads.
const globalScope = globalThis as typeof globalThis & {
  __appProxyPlanes?: { data: Plane; control: Plane };
};

const planes = (globalScope.__appProxyPlanes ??= { data: emptyPlane(), control: emptyPlane() });

function listen(plane: Plane, port: number): void {
  if (plane.server || !plane.handler) return;
  plane.server = Bun.serve({
    port,
    // Bun closes idle connections after 10s by default, which would cut off a
    // 30s delay or a `timeout` fault before the client ever gave up.
    idleTimeout: 0,
    fetch: plane.handler,
  });
  plane.downSince = null;
  plane.restoresAt = null;
}

function clearRestoreTimer(plane: Plane): void {
  if (plane.timer) clearTimeout(plane.timer);
  plane.timer = null;
  plane.restoresAt = null;
}

/** Start (or, on a hot reload, re-point) the forwarding listener. */
export function serveDataPlane(handler: FetchHandler): void {
  const plane = planes.data;
  plane.handler = handler;
  if (plane.server) {
    plane.server.reload({ fetch: handler });
    return;
  }
  // Deliberately down: a hot reload must not quietly bring it back.
  if (plane.downSince) return;
  listen(plane, PROXY_PORT);
}

/** Start (or re-point) the control listener. It is never stopped. */
export function serveControlPlane(handler: FetchHandler): void {
  const plane = planes.control;
  plane.handler = handler;
  if (plane.server) {
    plane.server.reload({ fetch: handler });
    return;
  }
  listen(plane, PROXY_CONTROL_PORT);
}

export interface StopOptions {
  /** Come back automatically after this many seconds. */
  seconds?: number;
  /**
   * Cut connections that are already open (including a request being held by a
   * `timeout` fault). False lets in-flight responses finish — which is what you
   * want when the request asking for the shutdown arrived on this very port.
   */
  closeActiveConnections?: boolean;
}

/** Stop listening: the port starts refusing connections outright. */
export function stopDataPlane(options: StopOptions = {}): DataPlaneStatus {
  const plane = planes.data;
  clearRestoreTimer(plane);

  const server = plane.server;
  plane.server = null;
  plane.downSince = new Date().toISOString();
  if (server) void server.stop(options.closeActiveConnections ?? true);

  const seconds = options.seconds ?? 0;
  if (seconds > 0) {
    plane.restoresAt = new Date(Date.now() + seconds * 1000).toISOString();
    plane.timer = setTimeout(() => {
      plane.timer = null;
      plane.downSince = null;
      listen(plane, PROXY_PORT);
      console.log(`🔌 [proxy] data plane back up on :${PROXY_PORT}`);
    }, seconds * 1000);
  }

  console.log(
    `🔌 [proxy] data plane down on :${PROXY_PORT}` +
      (seconds > 0 ? ` — back in ${seconds}s` : ` — POST http://localhost:${PROXY_CONTROL_PORT}/up to restore`),
  );
  return dataPlaneStatus();
}

/** Listen again. Throws if the port cannot be bound (reported as a 500). */
export function startDataPlane(): DataPlaneStatus {
  const plane = planes.data;
  clearRestoreTimer(plane);
  plane.downSince = null;
  listen(plane, PROXY_PORT);
  console.log(`🔌 [proxy] data plane listening on :${PROXY_PORT}`);
  return dataPlaneStatus();
}

export function dataPlaneStatus(): DataPlaneStatus {
  const plane = planes.data;
  return {
    port: PROXY_PORT,
    listening: plane.server !== null,
    downSince: plane.downSince,
    restoresAt: plane.restoresAt,
  };
}
