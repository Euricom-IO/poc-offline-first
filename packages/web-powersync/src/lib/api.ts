import { auth } from './auth';

// Requests are same-origin and proxied to the API by the vite dev server
// (see vite.config.ts). In production serve the SPA behind the same origin.
const BASE = '';

// A request that hangs (e.g. the fault-injection proxy's `timeout` rule) would
// otherwise never settle, so every call gets its own deadline.
const TIMEOUT_MS = 10_000;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');
  const token = auth.token;
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  const res = await fetch(`${BASE}${path}`, { ...options, headers, signal });

  if (res.status === 401) {
    auth.clear();
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? res.statusText);
  }

  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}
