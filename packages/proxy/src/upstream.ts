import { POWERSYNC_TARGET, PROXY_TARGET } from './config';

/**
 * What the proxy knows about each upstream behind it — the API and the
 * PowerSync service.
 *
 * The dashboard shows an "up" pill for both, but actively probing for that
 * shows up as a request in each service's own log — a few every minute, for a
 * fact that barely changes. So the answer is cached, and every forwarded
 * request refreshes it for free: if the upstream answered, it is reachable,
 * whatever status it chose. An actual probe only happens when nothing has
 * passed through recently.
 */

export type UpstreamName = 'api' | 'powersync';

export interface UpstreamState {
  target: string;
  reachable: boolean;
  status?: number;
  error?: string;
  durationMs: number;
  checkedAt: string;
  /** `traffic` — inferred from a forwarded request; `probe` — we asked. */
  source: 'traffic' | 'probe';
}

/** How long an observation stands before `/health` probes again. */
export const UPSTREAM_TTL_MS = 5_000;

/** Where to look when we do have to ask. PowerSync exposes a liveness probe. */
const PROBES: Record<UpstreamName, { base: string; path: string }> = {
  api: { base: PROXY_TARGET, path: '/health' },
  powersync: { base: POWERSYNC_TARGET, path: '/probes/liveness' },
};

const last: Record<UpstreamName, { at: number; state: UpstreamState } | null> = {
  api: null,
  powersync: null,
};

/** Record what forwarding a real request just told us about an upstream. */
export function recordUpstream(
  name: UpstreamName,
  result: { reachable: boolean; status?: number; error?: string; durationMs: number },
): void {
  const at = Date.now();
  last[name] = {
    at,
    state: {
      target: PROBES[name].base,
      reachable: result.reachable,
      ...(result.status !== undefined ? { status: result.status } : {}),
      ...(result.error ? { error: result.error } : {}),
      durationMs: result.durationMs,
      checkedAt: new Date(at).toISOString(),
      source: 'traffic',
    },
  };
}

async function probe(name: UpstreamName): Promise<UpstreamState> {
  const { base, path } = PROBES[name];
  const startedAt = Date.now();
  try {
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(2_000) });
    return {
      target: base,
      reachable: res.ok,
      status: res.status,
      durationMs: Date.now() - startedAt,
      checkedAt: new Date(startedAt).toISOString(),
      source: 'probe',
    };
  } catch (error) {
    return {
      target: base,
      reachable: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
      checkedAt: new Date(startedAt).toISOString(),
      source: 'probe',
    };
  }
}

/**
 * Current state of one upstream, probing only when what we have is stale.
 * `force` always probes (`GET /health?fresh`).
 */
export async function checkUpstream(
  name: UpstreamName,
  force = false,
): Promise<UpstreamState & { cached: boolean }> {
  const known = last[name];
  if (!force && known && Date.now() - known.at < UPSTREAM_TTL_MS) {
    return { ...known.state, cached: true };
  }
  const state = await probe(name);
  last[name] = { at: Date.now(), state };
  return { ...state, cached: false };
}
