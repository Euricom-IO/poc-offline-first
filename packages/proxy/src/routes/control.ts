import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  CONTROL_PREFIX,
  POWERSYNC_PREFIX,
  POWERSYNC_TARGET,
  PROXY_CONTROL_PORT,
  PROXY_PORT,
  PROXY_TARGET,
} from '../config';
import {
  clearFault,
  describeFault,
  FAULT_MODES,
  getFault,
  MAX_DELAY_MS,
  parseFault,
  setFault,
} from '../faults';
import { clearLog, getLog, getStats } from '../log';
import { checkUpstream } from '../upstream';
import { cutStreams, openStreams } from '../streams';
import { dataPlaneStatus, startDataPlane, stopDataPlane } from '../server';

/**
 * Control plane. It is mounted twice:
 *
 * - on the control port (:3101) at `/` and at `/__proxy` — always reachable,
 *   including while the data plane is stopped;
 * - on the data port (:3100) under `/__proxy` — convenient while it is up, and
 *   never forwarded or faulted.
 *
 * The scope only changes how `POST /down` shuts the data plane down: a request
 * that arrived on the port being stopped needs its own response to survive.
 */
export type ControlScope = 'data' | 'control';

/** Longest auto-restore window for `POST /down` — beyond that, use `/up`. */
const MAX_DOWN_SECONDS = 600;

/**
 * The dashboard, served from the control plane so it is still there when the
 * data plane is down. Read from disk per request (rather than bundled) so
 * editing it under `bun --hot` is a browser refresh away, and it is a plain
 * dependency-free page: the thing being tested is the network, so it must not
 * need one.
 */
const DASHBOARD_FILE = `${import.meta.dir}/../../public/dashboard.html`;

function dashboardResponse(): Response {
  return new Response(Bun.file(DASHBOARD_FILE), {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** Body is optional on every POST here — `{}` when absent or unparseable. */
async function readBody(c: Context): Promise<unknown> {
  return await c.req.json().catch(() => ({}));
}

function state(): Record<string, unknown> {
  const fault = getFault();
  return {
    target: PROXY_TARGET,
    powersyncTarget: POWERSYNC_TARGET,
    powersyncPrefix: POWERSYNC_PREFIX,
    dataPlane: dataPlaneStatus(),
    controlPlane: `http://localhost:${PROXY_CONTROL_PORT}`,
    fault,
    description: describeFault(fault),
    openStreams: openStreams(),
    stats: getStats(),
  };
}

export function createControlRoutes(scope: ControlScope): Hono {
  const routes = new Hono();

  // A browser opening the control plane gets the dashboard; every other client
  // (curl, the .http files) gets the JSON overview from the same URL.
  routes.get('/ui', () => dashboardResponse());

  routes.get('/', (c) => {
    if (scope === 'control' && (c.req.header('Accept') ?? '').includes('text/html')) {
      return dashboardResponse();
    }
    return c.json({
      name: '@app/proxy — fault-injection dev proxy',
      routes: {
        [`${PROXY_PORT}/api/*`]: `${PROXY_TARGET} — the Hono API (writes)`,
        [`${PROXY_PORT}${POWERSYNC_PREFIX}/*`]: `${POWERSYNC_TARGET} — the PowerSync service (download stream), prefix stripped`,
      },
      planes: {
        data: `http://localhost:${PROXY_PORT} → ${PROXY_TARGET} + ${POWERSYNC_TARGET} (faults apply here; can be taken down)`,
        control: `http://localhost:${PROXY_CONTROL_PORT} (this, always up; also at :${PROXY_PORT}${CONTROL_PREFIX} while the proxy is up)`,
      },
      endpoints: {
        'GET    /ui': 'the dashboard (also what GET / serves to a browser)',
        'GET    /status': 'armed fault, data-plane state, counters',
        'GET    /health': 'is the upstream API reachable?',
        'POST   /fault': 'arm a fault — { mode, status?, delaySeconds?, methods?, path?, count? }; add dryRun to describe it without arming',
        'DELETE /fault': 'disarm the fault',
        'POST   /offline': 'shorthand for { mode: "offline" } — 500 on every POST',
        'POST   /online': 'shorthand for disarming the fault',
        'POST   /cut': 'break open streaming responses so an armed fault bites a connected client — { path? }',
        'POST   /down': 'stop listening on the data port — clients get ECONNREFUSED — { seconds? }',
        'POST   /up': 'listen again',
        'POST   /reset': 'disarm, bring the data plane back, clear the log',
        'GET    /log': 'recent requests, newest first (?limit=n)',
        'DELETE /log': 'clear the request log',
      },
      modes: {
        offline: 'answer with `status` (default 500) without contacting the API',
        error: 'answer with any `status` you pass (400 poisons a sync queue, 401, 429, 503, …)',
        delay: `wait \`delaySeconds\` (max ${MAX_DELAY_MS / 1000}s), then forward`,
        timeout: 'never answer — the request hangs until the client gives up',
        disconnect: 'drop this one connection, so the client sees a network error',
        off: 'pass-through (same as DELETE /fault)',
      },
      defaults: {
        methods: ['POST'],
        path: 'every path',
        count: 'null — fault until cleared',
      },
      note: 'a fault breaks requests; POST /down breaks the whole listener (no server to connect to)',
      dashboard: `http://localhost:${PROXY_CONTROL_PORT}/ui`,
      ...state(),
    });
  });

  routes.get('/status', (c) => c.json(state()));

  /**
   * Reachability of the API behind the proxy — tells "I broke it" from "it is
   * down". Answered from what the last forwarded request already proved, and
   * only probes the API when that is stale (`?fresh` always probes). The
   * data-plane state is always current.
   */
  routes.get('/health', async (c) => {
    const fresh = c.req.query('fresh') !== undefined;
    const [api, powersync] = await Promise.all([
      checkUpstream('api', fresh),
      checkUpstream('powersync', fresh),
    ]);
    return c.json({
      proxy: 'ok',
      dataPlane: dataPlaneStatus(),
      // Flattened API fields kept as they were, plus both legs spelled out.
      target: api.target,
      targetReachable: api.reachable,
      ...(api.status !== undefined ? { targetStatus: api.status } : {}),
      checkedAt: api.checkedAt,
      cached: api.cached,
      source: api.source,
      api,
      powersync,
    });
  });

  // --- faults --------------------------------------------------------------

  /**
   * Arm a fault. This is the endpoint the .http files drive.
   *
   * `{ dryRun: true }` validates the rule and describes what it would do
   * without arming it — the dashboard uses it so the sentence it previews is
   * the server's own, not a second implementation that can drift. A dry run
   * always answers 200 (the question was asked and answered; `valid` says what
   * the answer is), which also keeps a half-typed rule out of the browser's
   * error console. Arming for real still fails with 400.
   */
  routes.post('/fault', async (c) => {
    const body = await readBody(c);
    const dryRun =
      typeof body === 'object' && body !== null && (body as { dryRun?: unknown }).dryRun === true;
    const parsed = parseFault(body);

    if (dryRun) {
      return parsed.ok
        ? c.json({ dryRun: true, valid: true, message: describeFault(parsed.rule), fault: parsed.rule })
        : c.json({ dryRun: true, valid: false, error: parsed.error });
    }
    if (!parsed.ok) {
      return c.json({ error: parsed.error, modes: FAULT_MODES }, 400);
    }
    setFault(parsed.rule);
    const fault = getFault();
    console.log(`🎛️  [proxy] fault armed: ${describeFault(fault)}`);
    return c.json({ message: describeFault(fault), fault });
  });

  routes.delete('/fault', (c) => {
    clearFault();
    console.log('🎛️  [proxy] fault cleared');
    return c.json({ message: describeFault(null), fault: null });
  });

  /** Shorthand: 500 on every POST until you call /online. Accepts the same options. */
  routes.post('/offline', async (c) => {
    const body = await readBody(c);
    const parsed = parseFault({ ...(typeof body === 'object' && body ? body : {}), mode: 'offline' });
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    setFault(parsed.rule);
    console.log(`🎛️  [proxy] offline: ${describeFault(getFault())}`);
    return c.json({ message: describeFault(getFault()), fault: getFault() });
  });

  routes.post('/online', (c) => {
    clearFault();
    console.log('🎛️  [proxy] online — forwarding normally');
    return c.json({ message: describeFault(null), fault: null });
  });

  // --- listener ------------------------------------------------------------

  /**
   * Take the data plane down: the port stops accepting connections, so a client
   * fails to connect at all rather than receiving an injected error.
   */
  routes.post('/down', async (c) => {
    const body = await readBody(c);
    const raw = typeof body === 'object' && body ? (body as { seconds?: unknown }).seconds : undefined;
    let seconds = 0;
    if (typeof raw === 'number') {
      if (!Number.isFinite(raw) || raw < 1 || raw > MAX_DOWN_SECONDS) {
        return c.json({ error: `seconds must be between 1 and ${MAX_DOWN_SECONDS} (omit it to stay down)` }, 400);
      }
      seconds = Math.round(raw);
    } else if (raw !== undefined && raw !== null) {
      return c.json({ error: 'seconds must be a number' }, 400);
    }

    const status = stopDataPlane({
      seconds,
      // Asked from the control port: cut everything, including a request being
      // held open by a `timeout` fault. Asked from the port that is going away:
      // let in-flight responses (this one) finish first.
      closeActiveConnections: scope === 'control',
    });
    return c.json({
      message:
        seconds > 0
          ? `data plane down for ${seconds}s — connections to :${PROXY_PORT} are refused until then`
          : `data plane down — connections to :${PROXY_PORT} are refused until POST http://localhost:${PROXY_CONTROL_PORT}/up`,
      dataPlane: status,
    });
  });

  /**
   * Break open streaming responses. A fault only applies to requests as they
   * arrive, so this is what makes one bite a client that is already connected —
   * its stream fails, it reconnects, and the armed fault is waiting.
   */
  routes.post('/cut', async (c) => {
    const body = await readBody(c);
    const raw = typeof body === 'object' && body ? (body as { path?: unknown }).path : undefined;
    if (raw !== undefined && typeof raw !== 'string') {
      return c.json({ error: 'path must be a string' }, 400);
    }
    const before = openStreams().length;
    const count = cutStreams(raw);
    console.log(`✂️  [proxy] cut ${count} of ${before} open stream(s)${raw ? ` under ${raw}` : ''}`);
    return c.json({
      message: `cut ${count} open stream(s)${raw ? ` under ${raw}` : ''}`,
      cut: count,
      openStreams: openStreams(),
    });
  });

  routes.post('/up', (c) => {
    try {
      return c.json({ message: `data plane listening on :${PROXY_PORT}`, dataPlane: startDataPlane() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: `could not bind :${PROXY_PORT} — ${message}`, dataPlane: dataPlaneStatus() }, 500);
    }
  });

  // --- observe -------------------------------------------------------------

  routes.post('/reset', (c) => {
    clearFault();
    clearLog();
    try {
      startDataPlane();
    } catch {
      // Someone else holds the port; /status will show it as down.
    }
    console.log('🎛️  [proxy] reset — fault cleared, data plane up, log emptied');
    return c.json({ message: 'reset: fault cleared, data plane up, log and counters emptied', ...state() });
  });

  routes.get('/log', (c) => {
    const limit = Number(c.req.query('limit') ?? 50);
    const entries = getLog(Number.isFinite(limit) ? limit : 50);
    return c.json({ stats: getStats(), count: entries.length, entries });
  });

  routes.delete('/log', (c) => {
    clearLog();
    return c.json({ message: 'log cleared', stats: getStats() });
  });

  return routes;
}
