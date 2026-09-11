/**
 * The armed fault: what the proxy should do instead of (or before) forwarding.
 *
 * There is at most one fault armed at a time — this is a manual test tool, and
 * one rule that is easy to read back from `GET /__proxy/status` beats a rule
 * engine. A rule is scoped by method and path prefix so, for example, only the
 * PowerSync upload (`POST /api/data`) breaks while login and the token endpoint
 * keep working.
 */

export const FAULT_MODES = ['off', 'offline', 'error', 'delay', 'timeout', 'disconnect'] as const;

export type FaultMode = (typeof FAULT_MODES)[number];

/** Upper bound for `delayMs` — the brief asks for delays of 1–30 seconds. */
export const MAX_DELAY_MS = 30_000;

export interface FaultRule {
  /**
   * - `off`        — nothing armed (pass-through).
   * - `offline`    — answer immediately with `status` (default 500); the
   *                  upstream is never contacted, which is what "the server is
   *                  gone" looks like to a client that still gets an HTTP
   *                  response.
   * - `error`      — same mechanism, for any status you want to test (400 to
   *                  poison a queue, 401, 429, 503, …).
   * - `delay`      — wait `delayMs`, then forward normally.
   * - `timeout`    — never answer; the request hangs until the client gives up.
   * - `disconnect` — drop the connection mid-response, so the client's `fetch`
   *                  rejects with a network error (`TypeError: Failed to fetch`)
   *                  exactly as it does when the browser is offline.
   */
  mode: FaultMode;
  /** Applied before the terminal behaviour above, in every mode. */
  delayMs: number;
  /** Uppercase methods the rule applies to; empty means every method. */
  methods: string[];
  /** Pathname prefix the rule applies to; empty means every path. */
  path: string;
  /** Requests left to fault; `null` means "until it is cleared". */
  remaining: number | null;
  /** Response status for `offline` / `error`. */
  status?: number;
  /** Response `{ error }` message for `offline` / `error`. */
  message?: string;
}

/** Shape accepted by `POST /__proxy/fault`. Every field except `mode` is optional. */
export interface FaultInput {
  mode?: string;
  status?: number;
  message?: string;
  delayMs?: number;
  delaySeconds?: number;
  methods?: string[] | string;
  path?: string;
  count?: number | null;
}

export type ParseResult = { ok: true; rule: FaultRule } | { ok: false; error: string };

const MODE_DEFAULTS: Record<FaultMode, { status?: number; message?: string; delayMs: number }> = {
  off: { delayMs: 0 },
  offline: { status: 500, message: 'proxy: simulated offline (not forwarded)', delayMs: 0 },
  error: { status: 500, message: 'proxy: simulated error', delayMs: 0 },
  delay: { delayMs: 5_000 },
  timeout: { delayMs: 0 },
  disconnect: { delayMs: 0 },
};

/**
 * Only writes are faulted by default. The frontends still need `GET` to work
 * while a fault is armed (login, `/api/powersync/token`), and the first step of
 * this proxy is about the POST path.
 */
const DEFAULT_METHODS = ['POST'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMethods(raw: unknown): string[] | { error: string } {
  if (raw === undefined || raw === null) return DEFAULT_METHODS;
  const list = Array.isArray(raw) ? raw : [raw];
  const methods: string[] = [];
  for (const entry of list) {
    if (typeof entry !== 'string') return { error: 'methods must be a string or an array of strings' };
    const method = entry.trim().toUpperCase();
    if (!method) continue;
    // '*' / 'ALL' / 'ANY' mean "every method".
    if (method === '*' || method === 'ALL' || method === 'ANY') return [];
    methods.push(method);
  }
  return methods;
}

function parseDelay(raw: Record<string, unknown>, fallback: number): number | { error: string } {
  const { delayMs, delaySeconds } = raw;
  let ms: number;
  if (typeof delaySeconds === 'number') ms = delaySeconds * 1000;
  else if (delaySeconds !== undefined) return { error: 'delaySeconds must be a number' };
  else if (typeof delayMs === 'number') ms = delayMs;
  else if (delayMs !== undefined) return { error: 'delayMs must be a number' };
  else return fallback;

  if (!Number.isFinite(ms) || ms < 0) return { error: 'delay must be a positive number' };
  if (ms > MAX_DELAY_MS) return { error: `delay must be at most ${MAX_DELAY_MS}ms (30s)` };
  return Math.round(ms);
}

/** Validate and normalise a control-plane payload into a rule. */
export function parseFault(input: unknown): ParseResult {
  if (!isPlainObject(input)) return { ok: false, error: 'expected a JSON object body' };

  const mode = typeof input.mode === 'string' ? (input.mode.trim().toLowerCase() as FaultMode) : undefined;
  if (!mode || !FAULT_MODES.includes(mode)) {
    return { ok: false, error: `mode must be one of: ${FAULT_MODES.join(', ')}` };
  }
  const defaults = MODE_DEFAULTS[mode];

  const delayMs = parseDelay(input, defaults.delayMs);
  if (typeof delayMs !== 'number') return { ok: false, error: delayMs.error };

  const methods = parseMethods(input.methods);
  if (!Array.isArray(methods)) return { ok: false, error: methods.error };

  let path = '';
  if (typeof input.path === 'string') path = input.path.trim();
  else if (input.path !== undefined) return { ok: false, error: 'path must be a string' };
  if (path && !path.startsWith('/')) return { ok: false, error: 'path must start with "/"' };

  let remaining: number | null = null;
  if (typeof input.count === 'number') {
    if (!Number.isInteger(input.count) || input.count < 1) {
      return { ok: false, error: 'count must be an integer >= 1 (omit it to fault until reset)' };
    }
    remaining = input.count;
  } else if (input.count !== undefined && input.count !== null) {
    return { ok: false, error: 'count must be a number or null' };
  }

  let status = defaults.status;
  if (typeof input.status === 'number') {
    if (!Number.isInteger(input.status) || input.status < 100 || input.status > 599) {
      return { ok: false, error: 'status must be an integer between 100 and 599' };
    }
    status = input.status;
  } else if (input.status !== undefined) {
    return { ok: false, error: 'status must be a number' };
  }

  const message = typeof input.message === 'string' && input.message ? input.message : defaults.message;

  return {
    ok: true,
    rule: {
      mode,
      delayMs,
      methods,
      path,
      remaining,
      ...(status !== undefined ? { status } : {}),
      ...(message !== undefined ? { message } : {}),
    },
  };
}

// --- state ----------------------------------------------------------------

let armed: FaultRule | null = null;

export function getFault(): FaultRule | null {
  return armed;
}

export function setFault(rule: FaultRule | null): void {
  armed = rule && rule.mode !== 'off' ? rule : null;
}

export function clearFault(): void {
  armed = null;
}

/**
 * Return the rule to apply to this request and count it against `remaining`,
 * disarming the rule once it is used up. Requests that do not match the rule's
 * method/path scope are forwarded untouched and do not consume a count.
 */
export function takeFault(method: string, pathname: string): FaultRule | null {
  const rule = armed;
  if (!rule) return null;
  if (rule.methods.length > 0 && !rule.methods.includes(method.toUpperCase())) return null;
  if (rule.path && !pathname.startsWith(rule.path)) return null;

  if (rule.remaining !== null) {
    const remaining = rule.remaining - 1;
    if (remaining <= 0) armed = null;
    else armed = { ...rule, remaining };
  }
  return rule;
}

/** One-line, human-readable summary — echoed back by the control endpoints. */
export function describeFault(rule: FaultRule | null): string {
  if (!rule) return 'pass-through (no fault armed)';

  const scope = `${rule.methods.length > 0 ? rule.methods.join('/') : 'ANY'} ${rule.path || '/*'}`;
  const steps: string[] = [];
  if (rule.delayMs > 0) steps.push(`wait ${rule.delayMs}ms`);
  switch (rule.mode) {
    case 'offline':
      steps.push(`answer ${rule.status} without forwarding`);
      break;
    case 'error':
      steps.push(`answer ${rule.status}`);
      break;
    case 'delay':
      steps.push('then forward');
      break;
    case 'timeout':
      steps.push('never answer');
      break;
    case 'disconnect':
      steps.push('drop the connection');
      break;
    case 'off':
      break;
  }
  const scopeCount = rule.remaining === null ? 'until cleared' : `next ${rule.remaining} request(s)`;
  return `${scope} → ${steps.join(', ')} (${scopeCount})`;
}
