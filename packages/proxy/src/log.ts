import type { FaultMode } from './faults';

/**
 * In-memory request log + counters.
 *
 * The point of the proxy is to watch what a client does while the network
 * misbehaves — when PowerSync retries, how long it waits, what the CRUD batch
 * looked like when it finally landed — so every request is recorded and read
 * back through `GET /__proxy/log`.
 *
 * An entry is written when the request **arrives**, not when it is answered: a
 * request stalled for 30s (or held forever by `timeout`) is the interesting one
 * to watch, and it would otherwise be invisible for exactly as long as it is
 * interesting. `finishRequest` fills in the outcome later.
 */

export interface LogEntry {
  /** Monotonic, so a UI can tell "same entry, re-rendered" from "new entry". */
  id: number;
  at: string;
  method: string;
  path: string;
  /** Which upstream it was headed for. */
  upstream: 'api' | 'powersync';
  /** In flight: the proxy has it and nothing has gone back to the client yet. */
  pending: boolean;
  /**
   * Answered, but the response body is still open — a PowerSync download stream
   * stays here for as long as the client is connected.
   */
  streaming: boolean;
  /** Response bytes forwarded so far. */
  bytes: number;
  /** Status sent to the client; `null` while pending, and for a dropped request. */
  status: number | null;
  /** Fault applied to this request, or `null` when it was forwarded untouched. */
  fault: FaultMode | null;
  delayMs: number;
  /** Time spent so far (pending) or in total (finished). */
  durationMs: number;
  /** Truncated request body, for JSON/text requests only. */
  body?: string;
}

/** What is known about a request the moment it arrives. */
export interface IncomingRequest {
  method: string;
  path: string;
  upstream: 'api' | 'powersync';
  fault: FaultMode | null;
  delayMs: number;
  body?: string;
}

export interface Stats {
  total: number;
  forwarded: number;
  faulted: number;
  since: string;
}

/** Newest first, capped — this is a dev tool, not a metrics backend. */
const MAX_ENTRIES = 50;
const MAX_BODY_CHARS = 800;

let entries: LogEntry[] = [];
let nextId = 1;
let total = 0;
let forwarded = 0;
let faulted = 0;
let since = new Date().toISOString();

/** Record an arriving request as pending, and hand back its entry. */
export function startRequest(request: IncomingRequest): LogEntry {
  total += 1;
  if (request.fault) faulted += 1;
  else forwarded += 1;
  // Ids keep counting across a clear: a client holding on to one should never
  // see it reused for a different request.
  const entry: LogEntry = {
    id: nextId++,
    at: new Date().toISOString(),
    pending: true,
    streaming: false,
    bytes: 0,
    status: null,
    durationMs: 0,
    ...request,
  };
  entries.unshift(entry);
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  return entry;
}

/**
 * Answer sent. `status` is `null` when the client got no response at all (a
 * dropped connection, or a held request the client gave up on). `streaming`
 * marks a response whose body is still open — {@link endStream} closes it off.
 * A no-op if the entry has already aged out of the buffer.
 */
export function finishRequest(id: number, status: number | null, streaming = false): void {
  const entry = entries.find((candidate) => candidate.id === id);
  if (!entry) return;
  entry.pending = false;
  entry.status = status;
  entry.durationMs = Date.now() - Date.parse(entry.at);
  // Guard the (impossible today, but cheap) case of a body that finished before
  // its own headers were recorded.
  if (!entry.bytes) entry.streaming = streaming;
}

/** The response body closed, was cancelled, or failed. */
export function endStream(id: number, bytes: number): void {
  const entry = entries.find((candidate) => candidate.id === id);
  if (!entry) return;
  entry.streaming = false;
  entry.bytes = bytes;
  entry.durationMs = Date.now() - Date.parse(entry.at);
}

export function getLog(limit = MAX_ENTRIES): LogEntry[] {
  return entries.slice(0, Math.max(0, limit));
}

export function getStats(): Stats {
  return { total, forwarded, faulted, since };
}

export function clearLog(): void {
  entries = [];
  total = 0;
  forwarded = 0;
  faulted = 0;
  since = new Date().toISOString();
}

/** Decode a request body for the log, but only when it is human-readable. */
export function previewBody(body: ArrayBuffer | null, contentType: string | null): string | undefined {
  if (!body || body.byteLength === 0) return undefined;
  if (contentType && !/json|text|urlencoded/i.test(contentType)) return `<${body.byteLength} bytes>`;
  const text = new TextDecoder().decode(body);
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}… (truncated)` : text;
}
