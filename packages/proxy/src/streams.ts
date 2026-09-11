import type { UpstreamName } from './upstream';

/**
 * Response bodies that are still open.
 *
 * The PowerSync download is one long-lived streaming response, and a fault only
 * applies to requests as they *arrive* — so arming one while a client is already
 * connected changes nothing until that connection breaks. `cutStreams` breaks it
 * on purpose: the client's stream fails exactly as it would on a dead network,
 * it reconnects, and the armed fault is what it runs into.
 */

export interface OpenStream {
  id: number;
  path: string;
  upstream: UpstreamName;
  startedAt: number;
  /** Ends this response body, which drops the client's connection. */
  cut: () => void;
}

const open = new Map<number, OpenStream>();

export function registerStream(stream: OpenStream): void {
  open.set(stream.id, stream);
}

export function unregisterStream(id: number): void {
  open.delete(id);
}

export function openStreams(): Array<{ id: number; path: string; upstream: UpstreamName; openMs: number }> {
  const now = Date.now();
  return [...open.values()].map(({ id, path, upstream, startedAt }) => ({
    id,
    path,
    upstream,
    openMs: now - startedAt,
  }));
}

/** Cut every open stream, or only those whose path starts with `pathPrefix`. */
export function cutStreams(pathPrefix?: string): number {
  const doomed = [...open.values()].filter(
    (stream) => !pathPrefix || stream.path.startsWith(pathPrefix),
  );
  for (const stream of doomed) stream.cut();
  return doomed.length;
}
