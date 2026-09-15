import { Hono } from 'hono';
import { db } from '@app/db';
import type { AppEnv, AuthUser } from '../auth';
import { authMiddleware } from '../middleware/auth';
import { applyTodoInsert, applyTodoUpdate, applyTodoDelete } from '../services/todos';
import { applyUserInsert, applyUserUpdate, applyUserDelete } from '../services/users';
import { ServiceError } from '../services/errors';

/**
 * PowerSync upload endpoint.
 *
 * The `web-powersync` client drains its local CRUD queue and POSTs the batch
 * here (see the PowerSync backend setup guide and the reference todolist demo:
 * https://docs.powersync.com/configuration/app-backend/setup). Each entry is a
 * CRUD operation the client applied locally and now wants applied to the source
 * database.
 */

export type UploadOp = 'PUT' | 'PATCH' | 'DELETE';

export interface UploadEntry {
  op: UploadOp;
  table: string;
  id?: string;
  data: Record<string, unknown> & { id?: string };
  metadata?: unknown;
}

export const dataRoutes = new Hono<AppEnv>();

dataRoutes.use('*', authMiddleware);

/**
 * Apply a single todo CRUD op inside a transaction. PowerSync CRUD ops map onto
 * our todo services: PUT → insert, PATCH → update, DELETE → delete. The op
 * carries the client-generated id in `data.id`, which the services use as the
 * primary key (insert is idempotent on it; update/delete target it).
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * PowerSync stores rows in SQLite, which has no boolean type, so a CRUD op
 * carries `completed` as 0/1 rather than as a JSON boolean. The shared services
 * work on the same shape the REST path parses out of JSON, so decode the SQLite
 * representation here at the transport boundary (as `extractPin` does for
 * metadata) rather than teaching the services about SQLite.
 *
 * The op also carries raw *column* names. `title` and `completed` happen to be
 * spelled the same either way, but `due_date` is the first field where the
 * PowerSync payload and the REST DTO genuinely differ, so rename it here too —
 * the services only ever see the REST-shaped `dueDate`.
 *
 * Note `'due_date' in data` rather than a truthiness check: an explicit null
 * clears the column and must survive, while an absent key must stay absent so
 * applyTodoUpdate leaves the column alone.
 */
function decodeTodoData(data: Record<string, unknown>): Record<string, unknown> {
  const decoded: Record<string, unknown> = { ...data };
  if (typeof decoded.completed === 'number') {
    decoded.completed = decoded.completed !== 0;
  }
  if ('due_date' in decoded) {
    decoded.dueDate = decoded.due_date;
    delete decoded.due_date;
  }
  return decoded;
}

async function applyTodoOp(tx: Tx, user: AuthUser, entry: UploadEntry): Promise<void> {
  const data = decodeTodoData({ ...entry.data, id: entry.id ?? entry.data?.id });
  switch (entry.op) {
    case 'PUT':
      await applyTodoInsert(tx, user, data);
      return;
    case 'PATCH':
      await applyTodoUpdate(tx, user, data);
      return;
    case 'DELETE':
      await applyTodoDelete(tx, user, data);
      return;
    default:
      throw new ServiceError(400, `unsupported op: ${entry.op}`);
  }
}

/**
 * PowerSync sends write-only fields (values that are never synced back to the
 * client) as operation metadata rather than as row columns. For users that is
 * the plaintext `pin` — the admin page attaches it via `{ metadata: { pin } }`
 * on insert/update. Depending on the transport the metadata arrives as an
 * object or a JSON string, so accept both and pull out the `pin`.
 */
function extractPin(metadata: unknown): string | undefined {
  let meta: unknown = metadata;
  if (typeof meta === 'string') {
    const raw = meta;
    try {
      meta = JSON.parse(raw);
    } catch {
      // Not JSON — treat the raw string as the pin itself.
      return raw || undefined;
    }
  }
  if (meta && typeof meta === 'object' && 'pin' in meta) {
    const pin = (meta as { pin?: unknown }).pin;
    return typeof pin === 'string' && pin ? pin : undefined;
  }
  return undefined;
}

/**
 * Apply a single user CRUD op inside a transaction, mirroring `applyTodoOp`.
 * Managing users is admin-only (the REST `/api/users` routes enforce this via
 * `adminOnly` middleware), so the same boundary is enforced here on the sync
 * path. The write-only `pin` rides along as operation metadata and is merged
 * into the payload the user services expect.
 */
async function applyUserOp(tx: Tx, actor: AuthUser, entry: UploadEntry): Promise<void> {
  if (actor.role !== 'admin') {
    throw new ServiceError(403, 'admin role required to modify users');
  }
  const pin = extractPin(entry.metadata);
  const data = {
    ...entry.data,
    id: entry.id ?? entry.data?.id,
    ...(pin ? { pin } : {}),
  };
  switch (entry.op) {
    case 'PUT':
      await applyUserInsert(tx, data);
      return;
    case 'PATCH':
      await applyUserUpdate(tx, data);
      return;
    case 'DELETE':
      await applyUserDelete(tx, actor, data);
      return;
    default:
      throw new ServiceError(400, `unsupported op: ${entry.op}`);
  }
}

/**
 * Apply a batch of client CRUD operations. The whole batch runs in one
 * transaction so it commits or rolls back atomically — matching how PowerSync
 * drains a CRUD batch (all-or-nothing before it calls `complete()`).
 */
async function updateBatch(actor: AuthUser, batch: UploadEntry[]): Promise<void> {
  console.log(`📥 [data] updateBatch — ${batch.length} op(s) from ${actor.name} (${actor.id})`);
  await db.transaction(async (tx) => {
    for (const [i, entry] of batch.entries()) {
      const id = entry.id ?? entry.data?.id;
      console.log(
        `   ${i + 1}. ${entry.op} ${entry.table} id=${id}`,
        'data=',
        entry.data,
        entry.metadata !== undefined ? `metadata=${JSON.stringify(entry.metadata)}` : '',
      );

      switch (entry.table) {
        case 'todos':
          await applyTodoOp(tx, actor, entry);
          break;
        case 'users':
          await applyUserOp(tx, actor, entry);
          break;
        default:
          // Unknown tables are logged and skipped rather than failing the
          // whole batch.
          console.warn(`   ⚠️  skipping unsupported table: ${entry.table}`);
      }
    }
  });
}

/**
 * Batch upload — the primary path used by the PowerSync connector.
 * Body: `{ batch: UploadEntry[] }`.
 */
dataRoutes.post('/', async (c) => {
  const actor = c.get('user');
  const body = await c.req.json<{ batch?: UploadEntry[] }>().catch(() => null);
  if (!body?.batch || !Array.isArray(body.batch)) {
    return c.json({ error: 'invalid body: expected { batch: [...] }' }, 400);
  }

  try {
    await updateBatch(actor, body.batch);
    return c.json({ message: `Batch completed: ${body.batch.length} op(s)` });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'unknown error';
    console.error('❌ [data] batch failed:', message);
    return c.json({ error: `Request failed: ${message}` }, 400);
  }
});

// Single-operation convenience routes, mirroring the reference demo. The
// PowerSync connector uses POST /, but these let PUT/PATCH/DELETE be driven
// directly (e.g. curl) against the same updateBatch logic.

dataRoutes.put('/', async (c) => {
  const actor = c.get('user');
  const { table, data } = await c.req.json<{ table: string; data: Record<string, unknown> }>();
  await updateBatch(actor, [{ op: 'PUT', table, data }]);
  return c.json({ message: `PUT completed for ${table} ${data?.id}` });
});

dataRoutes.patch('/', async (c) => {
  const actor = c.get('user');
  const { table, data } = await c.req.json<{ table: string; data: Record<string, unknown> }>();
  await updateBatch(actor, [{ op: 'PATCH', table, data }]);
  return c.json({ message: `PATCH completed for ${table} ${data?.id}` });
});

dataRoutes.delete('/', async (c) => {
  const actor = c.get('user');
  const { table, data } = await c.req.json<{ table: string; data: Record<string, unknown> }>();
  if (!table || !data?.id) {
    return c.json({ error: 'invalid body: expected table and data.id' }, 400);
  }
  await updateBatch(actor, [{ op: 'DELETE', table, data }]);
  return c.json({ message: `DELETE completed for ${table} ${data.id}` });
});
