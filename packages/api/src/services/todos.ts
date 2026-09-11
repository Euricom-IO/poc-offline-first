import { and, eq } from 'drizzle-orm';
import { db, todos } from '@app/db';
import type { TodoRow } from '@app/db';
import type { AuthUser } from '../auth';
import { ServiceError } from './errors';

// The transaction object passed to db.transaction(async (tx) => ...).
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Todo mutation services. Each operates on a caller-provided transaction and
 * does NOT call getTxid — the caller (REST route or events endpoint) owns the
 * transaction and the txid. Update/delete return `null` when no row matched so
 * the caller can decide whether that is a 404 (REST) or a no-op (events replay).
 */

export async function applyTodoInsert(
  tx: Tx,
  user: AuthUser,
  payload: Record<string, unknown>,
): Promise<TodoRow> {
  const title = String(payload.title ?? '').trim();
  if (!title) throw new ServiceError(400, 'title is required');
  const id = typeof payload.id === 'string' ? payload.id : undefined;

  // Idempotent on the primary key: a replayed insert (same client id) is a
  // no-op and we return the existing row rather than erroring.
  const [inserted] = await tx
    .insert(todos)
    .values({ userId: user.id, title, ...(id ? { id } : {}) })
    .onConflictDoNothing({ target: todos.id })
    .returning();
  if (inserted) return inserted;

  if (id) {
    const [existing] = await tx.select().from(todos).where(eq(todos.id, id));
    if (existing) return existing;
  }
  throw new ServiceError(409, 'Todo insert conflict');
}

export async function applyTodoUpdate(
  tx: Tx,
  user: AuthUser,
  payload: Record<string, unknown>,
): Promise<TodoRow | null> {
  const id = String(payload.id ?? '');
  const patch: Partial<{ title: string; completed: boolean }> = {};
  if (typeof payload.title === 'string') patch.title = payload.title.trim();
  if (typeof payload.completed === 'boolean') patch.completed = payload.completed;

  // A payload with no recognised fields would make drizzle throw "No values to
  // set", which the sync write paths can only report as a terminal error and
  // then retry forever. Treat it as an applied no-op instead.
  if (Object.keys(patch).length === 0) {
    const [current] = await tx
      .select()
      .from(todos)
      .where(and(eq(todos.id, id), eq(todos.userId, user.id)));
    return current ?? null;
  }

  const [row] = await tx
    .update(todos)
    .set(patch)
    .where(and(eq(todos.id, id), eq(todos.userId, user.id)))
    .returning();
  return row ?? null;
}

export async function applyTodoDelete(
  tx: Tx,
  user: AuthUser,
  payload: Record<string, unknown>,
): Promise<TodoRow | null> {
  const id = String(payload.id ?? '');
  const [row] = await tx
    .delete(todos)
    .where(and(eq(todos.id, id), eq(todos.userId, user.id)))
    .returning();
  return row ?? null;
}
