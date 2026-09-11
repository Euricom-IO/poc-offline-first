import type { Context } from 'hono';
import { forward, resolveRoute } from './forward';
import { takeFault } from './faults';
import type { LogEntry } from './log';
import { endStream, finishRequest, previewBody, startRequest } from './log';
import { registerStream, unregisterStream } from './streams';

/** Methods whose body we never buffer (and which the frontends only read with). */
const BODYLESS_METHODS = new Set(['GET', 'HEAD']);

/** Safety net for `timeout`: hang for at most this long if the client never goes away. */
const MAX_HOLD_MS = 10 * 60_000;

/**
 * Close the connection without finishing the response. Erroring the body stream
 * is what actually drops the socket in Bun — the client's `fetch` then rejects
 * with a network error instead of resolving with a status, which is exactly how
 * an offline browser fails. The reason is a string rather than an Error so Bun
 * reports it as one line instead of a stack trace that reads like a crash.
 */
function disconnectResponse(): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.error('proxy: simulated disconnect');
    },
  });
  return new Response(stream, { status: 200 });
}

/**
 * Pass the response body through unchanged while counting it, so the log can
 * show a long-lived stream as still open and report what it has carried. The
 * wrapper reads only as fast as the client does, so backpressure is preserved.
 */
function trackStream(
  body: ReadableStream<Uint8Array>,
  entry: LogEntry,
  onEnd: (bytes: number) => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let bytes = 0;
  let ended = false;
  let cut = false;

  const end = (): void => {
    if (ended) return;
    ended = true;
    unregisterStream(entry.id);
    onEnd(bytes);
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      // Registered so `POST /cut` can break an established stream on demand.
      registerStream({
        id: entry.id,
        path: entry.path,
        upstream: entry.upstream,
        startedAt: Date.parse(entry.at),
        cut: () => {
          cut = true;
          try {
            controller.error(new Error('proxy: stream cut'));
          } catch {
            // Already closed or errored — nothing left to cut.
          }
          void reader.cancel('proxy: stream cut').catch(() => {});
          end();
        },
      });
    },
    async pull(controller) {
      if (cut) return;
      try {
        const { done, value } = await reader.read();
        if (cut) return;
        if (done) {
          end();
          controller.close();
          return;
        }
        bytes += value.byteLength;
        // The entry is the live object in the ring buffer, so a stream open for
        // minutes still shows what it has carried so far.
        entry.bytes = bytes;
        controller.enqueue(value);
      } catch (error) {
        end();
        if (!cut) controller.error(error);
      }
    },
    cancel(reason) {
      end();
      return reader.cancel(reason);
    },
  });
}

/** Never answer: hold the request until the client aborts it (or we give up). */
async function holdUntilClientGivesUp(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, MAX_HOLD_MS);
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Data plane: apply the armed fault (if this request is in its scope), then
 * forward whatever is left to the API.
 */
export async function proxyHandler(c: Context): Promise<Response> {
  const request = c.req.raw;
  const method = request.method.toUpperCase();
  const url = new URL(request.url);

  const route = resolveRoute(url);

  // The proxy speaks HTTP only. PowerSync's default transport is a WebSocket,
  // so an upgrade arriving here means the client is configured for the wrong
  // one — answer with something that says that rather than failing obscurely.
  if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
    return Response.json(
      {
        error:
          'proxy: WebSocket upgrades are not forwarded. Use PowerSync\'s HTTP streaming transport (VITE_POWERSYNC_TRANSPORT unset), or point the client straight at the service to use WebSockets.',
      },
      { status: 501 },
    );
  }

  const body = BODYLESS_METHODS.has(method) ? null : await request.arrayBuffer();
  const fault = takeFault(method, url.pathname);
  const bodyPreview = previewBody(body, request.headers.get('content-type'));

  // Logged on arrival, so a stalled or hanging request is visible *while* it is
  // stuck rather than only once it is over.
  const entry = startRequest({
    method,
    path: `${url.pathname}${url.search}`,
    upstream: route.upstream,
    fault: fault?.mode ?? null,
    delayMs: fault?.delayMs ?? 0,
    ...(bodyPreview ? { body: bodyPreview } : {}),
  });
  const record = (status: number | null, streaming = false): void =>
    finishRequest(entry.id, status, streaming);

  if (fault) {
    console.log(`🌩️  [proxy] ${fault.mode} ${method} ${url.pathname}`);
    // The delay applies in every mode: `delay` forwards afterwards, the others
    // stall first and then misbehave.
    if (fault.delayMs > 0) await Bun.sleep(fault.delayMs);

    switch (fault.mode) {
      case 'offline':
      case 'error': {
        const status = fault.status ?? 500;
        record(status);
        return Response.json(
          {
            error: fault.message ?? 'proxy: simulated error',
            proxy: { mode: fault.mode, delayMs: fault.delayMs },
          },
          { status },
        );
      }
      case 'disconnect':
        record(null);
        return disconnectResponse();
      case 'timeout':
        await holdUntilClientGivesUp(request.signal);
        record(null);
        return new Response(null, { status: 504 });
      case 'delay':
      case 'off':
        break;
    }
  }

  const response = await forward(request, body, route);
  if (!response.body) {
    record(response.status);
    return response;
  }

  // Keep the entry marked as streaming until the body actually closes — for the
  // PowerSync download that is the whole life of the connection.
  const tracked = trackStream(response.body, entry, (bytes) => endStream(entry.id, bytes));
  record(response.status, true);
  return new Response(tracked, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
