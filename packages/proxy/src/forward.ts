import { POWERSYNC_PREFIX, POWERSYNC_TARGET, PROXY_TARGET } from './config';
import { recordUpstream } from './upstream';

/** Which upstream a request belongs to, and where it is actually sent. */
export interface Route {
  upstream: 'api' | 'powersync';
  url: string;
}

/**
 * Pick the upstream from the path. Everything is the API except the PowerSync
 * prefix, which is stripped on the way through — the service knows nothing
 * about being proxied.
 */
export function resolveRoute(url: URL): Route {
  const { pathname, search } = url;
  if (pathname === POWERSYNC_PREFIX || pathname.startsWith(`${POWERSYNC_PREFIX}/`)) {
    const path = pathname.slice(POWERSYNC_PREFIX.length) || '/';
    return { upstream: 'powersync', url: `${POWERSYNC_TARGET}${path}${search}` };
  }
  return { upstream: 'api', url: `${PROXY_TARGET}${pathname}${search}` };
}

/**
 * Verbatim forwarding to the API.
 *
 * Hop-by-hop headers describe a single connection and must not be copied to the
 * other side. `content-encoding` / `content-length` are dropped for the same
 * reason: `fetch` hands back a decoded body, so passing the upstream's
 * `content-encoding: gzip` through would leave the client trying to gunzip
 * plain JSON.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
  'host',
]);

function copyHeaders(source: Headers): Headers {
  const headers = new Headers();
  source.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });
  return headers;
}

/**
 * Forward one request to its upstream and stream the answer back. The body is
 * passed in already buffered so the proxy can also log it; bodyless methods
 * pass `null`.
 *
 * The response body is handed back as-is — never buffered — because the
 * PowerSync download is one long-lived streaming response that has to arrive
 * chunk by chunk.
 */
export async function forward(
  request: Request,
  body: ArrayBuffer | null,
  route: Route,
): Promise<Response> {
  const startedAt = Date.now();

  try {
    const upstream = await fetch(route.url, {
      method: request.method,
      headers: copyHeaders(request.headers),
      body: body && body.byteLength > 0 ? body : undefined,
      // Let the client see a redirect rather than following it inside the proxy.
      redirect: 'manual',
    });
    // It answered, so it is up — whatever status it chose. That spares the
    // control plane from probing while traffic is flowing.
    recordUpstream(route.upstream, {
      reachable: true,
      status: upstream.status,
      durationMs: Date.now() - startedAt,
    });
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: copyHeaders(upstream.headers),
    });
  } catch (error) {
    // The API itself is down/unreachable — report it as a gateway error rather
    // than as a fault the proxy injected, so the two cases stay tellable apart.
    const message = error instanceof Error ? error.message : String(error);
    recordUpstream(route.upstream, {
      reachable: false,
      error: message,
      durationMs: Date.now() - startedAt,
    });
    const target = route.upstream === 'powersync' ? POWERSYNC_TARGET : PROXY_TARGET;
    return Response.json({ error: `proxy: cannot reach ${target} (${message})` }, { status: 502 });
  }
}
