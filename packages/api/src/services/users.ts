import { eq } from 'drizzle-orm';
import { db, users } from '@app/db';
import type { UserRow } from '@app/db';
import type { Role } from '@app/db/types';
import type { AuthUser } from '../auth';
import { ServiceError } from './errors';

// The transaction object passed to db.transaction(async (tx) => ...).
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * User mutation services (admin-gated by the caller). Like the todo services
 * they run inside a caller-provided transaction and never call getTxid.
 */

export async function applyUserInsert(
  tx: Tx,
  payload: Record<string, unknown>,
): Promise<UserRow> {
  const name = String(payload.name ?? '').trim();
  const pin = String(payload.pin ?? '');
  const role: Role = payload.role === 'admin' ? 'admin' : 'user';
  if (!name || !pin) throw new ServiceError(400, 'name and pin are required');

  const pinHash = await Bun.password.hash(pin);
  const id = typeof payload.id === 'string' ? payload.id : undefined;
  try {
    // Idempotent on the primary key only: a replayed insert (same id) is a
    // no-op, but a genuine duplicate name still trips the unique constraint.
    const [inserted] = await tx
      .insert(users)
      .values({ name, pinHash, role, ...(id ? { id } : {}) })
      .onConflictDoNothing({ target: users.id })
      .returning();
    if (inserted) return inserted;
  } catch {
    throw new ServiceError(409, 'A user with that name already exists');
  }

  if (id) {
    const [existing] = await tx.select().from(users).where(eq(users.id, id));
    if (existing) return existing;
  }
  throw new ServiceError(409, 'A user with that name already exists');
}

export async function applyUserUpdate(
  tx: Tx,
  payload: Record<string, unknown>,
): Promise<UserRow | null> {
  const id = String(payload.id ?? '');
  const patch: Partial<{ name: string; role: Role; pinHash: string }> = {};
  if (typeof payload.name === 'string') patch.name = payload.name.trim();
  if (payload.role === 'admin' || payload.role === 'user') patch.role = payload.role;
  if (typeof payload.pin === 'string' && payload.pin) {
    patch.pinHash = await Bun.password.hash(payload.pin);
  }

  // As in applyTodoUpdate: an empty patch would make drizzle throw rather than
  // be the no-op the sync replay paths expect.
  if (Object.keys(patch).length === 0) {
    const [current] = await tx.select().from(users).where(eq(users.id, id));
    return current ?? null;
  }

  const [row] = await tx.update(users).set(patch).where(eq(users.id, id)).returning();
  return row ?? null;
}

export async function applyUserDelete(
  tx: Tx,
  actor: AuthUser,
  payload: Record<string, unknown>,
): Promise<UserRow | null> {
  const id = String(payload.id ?? '');
  if (id === actor.id) {
    throw new ServiceError(400, 'You cannot delete your own account');
  }
  const [row] = await tx.delete(users).where(eq(users.id, id)).returning();
  return row ?? null;
}
