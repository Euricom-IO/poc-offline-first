import {
  PowerSyncDatabase,
  WASQLiteOpenFactory,
  WASQLiteVFS,
  Schema,
  SyncStreamConnectionMethod,
  Table,
  column,
  type AbstractPowerSyncDatabase,
  type CrudEntry,
  type PowerSyncBackendConnector,
  type PowerSyncCredentials,
} from '@powersync/web';
import { api } from '@/lib/api';
import { auth } from '@/lib/auth';

/**
 * PowerSync client for the `web-powersync` app.
 *
 * Reads and writes both go through a local SQLite database managed by PowerSync
 * (persisted in the browser via wa-sqlite/IndexedDB). Mutations are captured in
 * PowerSync's durable CRUD queue and drained by {@link ApiConnector.uploadData},
 * which POSTs them to the backend `/api/data` endpoint. Reads eventually stream
 * back down from a PowerSync service (see `VITE_POWERSYNC_URL`).
 */

// ---------------------------------------------------------------------------
// Schema
//
// PowerSync tables always carry an implicit `id TEXT` primary key, so only the
// remaining columns are declared. Booleans/timestamps have no native SQLite
// type: `completed` is stored as an integer (0/1) and `created_at` as ISO text;
// the collections (see src/collections) transform these into rich JS types.
//
// `trackMetadata: true` adds a hidden `_metadata` column so per-operation
// metadata passed to insert/update/delete surfaces on each CrudEntry during
// upload — we use it to carry the write-only user `pin`, which is never a
// synced column.
// ---------------------------------------------------------------------------
export const APP_SCHEMA = new Schema({
  todos: new Table(
    {
      user_id: column.text,
      title: column.text,
      completed: column.integer,
      // Nullable ISO text, like created_at — SQLite has no timestamp type.
      due_date: column.text,
      created_at: column.text,
    },
    { trackMetadata: true },
  ),
  users: new Table(
    {
      name: column.text,
      role: column.text,
      created_at: column.text,
    },
    { trackMetadata: true },
  ),
});

export type AppSchema = typeof APP_SCHEMA;

// Use the IndexedDB-backed VFS so the app works without cross-origin isolation
// (the OPFS VFS would require COOP/COEP headers on the dev server).
//
// `enableMultiTabs: false` disables PowerSync's SharedWorker. By default (when
// `SharedWorker` exists) all tabs of the same browser share ONE DB connection
// and ONE sync stream in a single leader tab. In that mode the TanStack DB
// collection's diff-trigger reactivity fires in the leader but does not
// propagate to other tabs, so a synced-in row lands in the shared local DB
// (visible after reload) but the other tab's live query never re-runs. With
// the SharedWorker off, every tab runs its own sync connection + reactivity —
// matching the separate-browser behaviour — so cross-tab updates are live.
// Trade-off: each open tab holds its own sync connection to the service.
export const db = new PowerSyncDatabase({
  database: new WASQLiteOpenFactory({
    dbFilename: 'todos-powersync.sqlite',
    vfs: WASQLiteVFS.IDBBatchAtomicVFS,
    flags: { enableMultiTabs: false },
  }),
  schema: APP_SCHEMA,
  flags: { enableMultiTabs: false },
});

// The PowerSync service endpoint (self-hosted or PowerSync Cloud) that streams
// changes back down. Left unset in this POC — see initPowerSync() below.
// Note the endpoint returned by GET /api/powersync/token wins over this one.
const POWERSYNC_URL = import.meta.env.VITE_POWERSYNC_URL as string | undefined;

/**
 * Whether a download stream is expected at all.
 *
 * With no service configured, initPowerSync() runs the POC bridge below and
 * never calls `db.connect()`, so `db.currentStatus.connected` stays false for
 * the life of the page. The sync badge needs that distinction: "not connected
 * because there is nothing to connect to" must not be reported as a broken
 * connection.
 */
export const DOWNLOAD_STREAM_ENABLED = Boolean(POWERSYNC_URL);

/**
 * Transport for the download stream.
 *
 * The SDK's default is a WebSocket (RSocket framing over `ws://…/sync/stream`).
 * This POC uses PowerSync's **HTTP streaming** mode instead — one long-lived
 * `POST /sync/stream` whose response is newline-delimited JSON — because that
 * is an ordinary HTTP request, so it can be routed through the fault-injection
 * proxy (packages/proxy) and made to fail, stall or drop like any other. The
 * cost is the slightly chattier HTTP framing.
 *
 * Set `VITE_POWERSYNC_TRANSPORT=websocket` to use the default instead; then
 * point `POWERSYNC_URL` back at the service directly (`http://localhost:8080`),
 * because the proxy does not bridge WebSocket upgrades.
 */
const CONNECTION_METHOD =
  (import.meta.env.VITE_POWERSYNC_TRANSPORT as string | undefined) === 'websocket'
    ? SyncStreamConnectionMethod.WEB_SOCKET
    : SyncStreamConnectionMethod.HTTP;

/** One upload item as understood by the backend `/api/data` endpoint. */
export interface UploadOp {
  op: string; // 'PUT' | 'PATCH' | 'DELETE'
  table: string;
  id: string;
  data: Record<string, unknown>;
  metadata?: unknown;
}

function toUploadOp(entry: CrudEntry): UploadOp {
  return {
    op: entry.op,
    table: entry.table,
    id: entry.id,
    // Always include the id in the row payload so PUT/PATCH/DELETE can target it.
    data: { ...(entry.opData ?? {}), id: entry.id },
    metadata: entry.metadata ? JSON.parse(entry.metadata) : undefined,
  };
}

/**
 * Backend connector. `uploadData` is PowerSync's single write path: it drains
 * the local CRUD queue and POSTs the batch to our Hono API. `fetchCredentials`
 * supplies the token/endpoint for the (optional) download stream.
 */
export class ApiConnector implements PowerSyncBackendConnector {
  async fetchCredentials(): Promise<PowerSyncCredentials | null> {
    console.log('[powersync] fetching credentials for', POWERSYNC_URL, 'token', auth.token);
    // No service configured, or nobody logged in → nothing to connect with.
    if (!POWERSYNC_URL) return null;
    if (!auth.token) return null;
    // Exchange the (long-lived) session token for a short-lived, PowerSync-shaped
    // token. PowerSync verifies it statically and refreshes via this method as it
    // nears expiry. The `api` helper attaches the session token as the Bearer.
    const { token, endpoint } = await api<{ token: string; endpoint: string }>(
      '/api/powersync/token',
    );
    return { endpoint: endpoint || POWERSYNC_URL, token };
  }

  async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
    const batch = await database.getCrudBatch();
    if (!batch) return;

    const ops = batch.crud.map(toUploadOp);
    // Throwing here (e.g. a network/API failure) leaves the batch in the queue
    // so PowerSync retries it later — do NOT call complete() on failure.
    await api('/api/data', {
      method: 'POST',
      body: JSON.stringify({ batch: ops }),
    });
    await batch.complete();
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

const connector = new ApiConnector();

/** Guard so a re-render / HMR reload never double-flushes the same batch. */
let flushing = false;

/**
 * POC bridge: with no PowerSync service configured, the sync engine's own
 * upload loop never runs, so we drain the CRUD queue ourselves whenever a
 * tracked table changes. This exercises the backend `/api/data` endpoint
 * end-to-end today; once `VITE_POWERSYNC_URL` points at a real service this is
 * replaced by `db.connect(connector)` and PowerSync owns the upload loop.
 */
async function flushQueue(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    // Keep draining while there is anything queued.
    for (;;) {
      const batch = await db.getCrudBatch();
      if (!batch) break;
      await connector.uploadData(db);
    }
  } catch (err) {
    // Leave the batch queued; the next change (or reload) retries it.
    console.warn('[powersync] upload flush failed, will retry', err);
  } finally {
    flushing = false;
  }
}

let started = false;

/** Initialise the local DB and start syncing. Safe to call more than once. */
export async function initPowerSync(): Promise<void> {
  if (started) return;
  started = true;

  await db.init();

  console.log('[powersync] init', POWERSYNC_URL);

  if (POWERSYNC_URL) {
    // Real service configured: PowerSync drives both download and upload.
    console.log('[powersync] connecting over', CONNECTION_METHOD);
    await db.connect(connector, { connectionMethod: CONNECTION_METHOD });
    return;
  }



  // No service yet: drive uploads ourselves so writes still reach the backend.
  console.log('[powersync] init, missing POWERSYNC_URL, draining CRUD queue manually');
  await flushQueue();
  db.onChange(
    { onChange: () => void flushQueue() },
    { tables: ['todos', 'users'] },
  );
}
