import { useEffect, useReducer, useState, useSyncExternalStore } from 'react';
import { CloudOff, CloudAlert, RefreshCw, Check } from 'lucide-react';
import type { SyncStatus as PowerSyncStatus } from '@powersync/web';
import { db, DOWNLOAD_STREAM_ENABLED } from '@/lib/powersync';
import { cn } from '@/lib/utils';

function subscribeOnline(cb: () => void): () => void {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}

/**
 * The parts of PowerSync's `SyncStatus` this badge renders, flattened.
 *
 * Kept as a plain snapshot rather than the SyncStatus object itself: PowerSync
 * may update that object in place, so storing it directly makes React's
 * identity check drop the change and the badge sticks on a stale state.
 */
interface SyncSnapshot {
  connected: boolean;
  connecting: boolean;
  lastSyncedAt?: number;
  downloadError?: string;
  uploadError?: string;
}

function snapshot(status: PowerSyncStatus): SyncSnapshot {
  return {
    connected: status.connected,
    connecting: status.connecting,
    lastSyncedAt: status.lastSyncedAt?.getTime(),
    downloadError: status.dataFlowStatus.downloadError?.message,
    uploadError: status.dataFlowStatus.uploadError?.message,
  };
}

function sameSnapshot(a: SyncSnapshot, b: SyncSnapshot): boolean {
  return (
    a.connected === b.connected &&
    a.connecting === b.connecting &&
    a.lastSyncedAt === b.lastSyncedAt &&
    a.downloadError === b.downloadError &&
    a.uploadError === b.uploadError
  );
}

/** "12s" / "3m" / "2h" — how long ago, at a glance. */
function since(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

/**
 * Header badge reflecting PowerSync state.
 *
 * It reports on **both** sync directions, because either can fail on its own
 * and each failure looks completely different to the user:
 *
 * - uploads — the number of local writes still in PowerSync's CRUD queue;
 * - downloads — whether the sync stream is actually connected.
 *
 * Reporting only the upload queue (as this did) makes the two worst states
 * invisible. A dead download stream leaves every local write succeeding and the
 * queue empty, so the badge said "Synced" while the client silently went stale;
 * and an unreachable server is not a browser-offline event, so `navigator.onLine`
 * stays true and a permanently failing upload read as an ordinary "Syncing 1".
 * Both now surface as "Not syncing", with how long the client has been stale.
 *
 * Verified against the fault-injection proxy — see "Sync fault checklist" in
 * packages/proxy/README.md, whose scenarios are what each state corresponds to.
 */
export function SyncStatus() {
  const online = useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
  const [pending, setPending] = useState(0);
  const [status, setStatus] = useState<SyncSnapshot>(() => snapshot(db.currentStatus));

  useEffect(() => {
    let active = true;
    const readStatus = () => {
      if (!active) return;
      const next = snapshot(db.currentStatus);
      setStatus((prev) => (sameSnapshot(prev, next) ? prev : next));
    };
    const refresh = async () => {
      // Re-read connection state on the same tick as the queue. `statusChanged`
      // below is what makes the badge react immediately, but it is an event on
      // a possibly-mutated object; re-reading here is what guarantees the badge
      // converges on the truth rather than sticking on a missed transition.
      readStatus();
      try {
        const stats = await db.getUploadQueueStats();
        if (active) setPending(stats.count);
      } catch {
        // Transient (e.g. DB busy) — the next poll will re-read.
      }
    };
    void refresh();
    // Poll the CRUD queue directly. This is the source of truth for "how many
    // local writes are still pending upload", and unlike event triggers it
    // always converges: a completed upload clears PowerSync's internal queue
    // (`ps_crud`, not a tracked table) without firing a todos/users onChange, so
    // an event-only approach could stay stuck on "Syncing". Polling settles it.
    const interval = setInterval(() => void refresh(), 500);
    // Also re-read the instant a tracked table changes so a new write flips the
    // badge to "Syncing" immediately rather than up to one poll interval later.
    const disposeChange = db.onChange(
      { onChange: () => void refresh() },
      { tables: ['todos', 'users'] },
    );
    // Connection state comes from PowerSync itself rather than being polled:
    // `statusChanged` fires on connect, disconnect and every download/upload
    // error, which is exactly when this badge has to change.
    const disposeStatus = db.registerListener({ statusChanged: () => readStatus() });
    return () => {
      active = false;
      clearInterval(interval);
      disposeChange();
      disposeStatus();
    };
  }, []);

  // Only meaningful when a stream is configured at all; in the bridge mode
  // there is no connection to lose.
  const streamDown = DOWNLOAD_STREAM_ENABLED && online && !status.connected;
  const { downloadError, uploadError } = status;
  const uploadFailing = Boolean(uploadError) && pending > 0;

  // How long the stream has been down, which is what separates a blip from an
  // outage. Deliberately NOT derived from `status.connecting`: that flag flaps
  // true/false on every retry attempt, so keying the badge off it makes it
  // alternate between two states once a second and never says how stale the
  // client actually is.
  const [downSince, setDownSince] = useState<number | null>(null);
  useEffect(() => {
    if (!streamDown) {
      setDownSince(null);
      return;
    }
    setDownSince((prev) => prev ?? Date.now());
  }, [streamDown]);

  // Staleness is a moving number, so it needs its own tick — nothing else
  // re-renders this component while the connection is simply down.
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!streamDown) return;
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [streamDown]);

  // A short grace period so an ordinary reconnect (or the initial connect) does
  // not flash a scary badge; past it, the outage is real and gets named.
  const RECONNECT_GRACE_MS = 10_000;
  const downFor = downSince === null ? 0 : Date.now() - downSince;
  const reconnecting = streamDown && downFor < RECONNECT_GRACE_MS;
  const notSyncing = streamDown && downFor >= RECONNECT_GRACE_MS;

  const lastSynced = status.lastSyncedAt;
  const stale = lastSynced ? ` · ${since(lastSynced)} stale` : ' · never synced';
  const queued = pending > 0 ? ` · ${pending} pending` : '';

  return <div className="flex items-center gap-2">{badge()}</div>;

  function badge() {
    if (!online) {
      return (
        <Pill className="bg-amber-100 text-amber-800" title="The browser reports no network.">
          <CloudOff className="size-3.5" />
          Offline{queued}
        </Pill>
      );
    }

    // The network is fine but the stream is not connected — an unreachable or
    // broken server, which `navigator.onLine` cannot see.
    if (notSyncing) {
      return (
        <Pill
          className="bg-red-100 text-red-800"
          title={
            'The network is up but the sync stream is not connected, so changes from other ' +
            'users are not arriving.' +
            (lastSynced
              ? ` Last full sync ${since(lastSynced)} ago.`
              : ' No sync has completed yet.') +
            (downloadError ? ` Download error: ${downloadError}` : '')
          }
        >
          <CloudAlert className="size-3.5" />
          Not syncing{stale}
          {queued}
        </Pill>
      );
    }

    if (reconnecting) {
      return (
        <Pill className="bg-amber-100 text-amber-800" title="Re-establishing the sync stream.">
          <RefreshCw className="size-3.5 animate-spin" />
          Reconnecting{queued}
        </Pill>
      );
    }

    if (pending > 0) {
      return (
        <Pill
          className={uploadFailing ? 'bg-amber-100 text-amber-800' : 'bg-muted text-muted-foreground'}
          title={
            uploadFailing
              ? `Upload failing and being retried: ${uploadError ?? ''}`
              : 'Local writes are on their way to the server.'
          }
        >
          <RefreshCw className="size-3.5 animate-spin" />
          {uploadFailing ? `Retrying ${pending}` : `Syncing ${pending}`}
        </Pill>
      );
    }

    return (
      <Pill
        className="bg-emerald-100 text-emerald-800"
        title={
          DOWNLOAD_STREAM_ENABLED
            ? `Connected${lastSynced ? `, last synced ${since(lastSynced)} ago` : ''}.`
            : 'Local writes are flushed to the API; no download stream is configured.'
        }
      >
        <Check className="size-3.5" />
        Synced
      </Pill>
    );
  }
}

function Pill({
  className,
  title,
  children,
}: {
  className?: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
        className,
      )}
    >
      {children}
    </span>
  );
}
