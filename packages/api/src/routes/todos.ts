import { Hono } from 'hono';
import { desc, eq } from 'drizzle-orm';
import { db, todos } from '@app/db';
import type { AppEnv } from '../auth';
import { authMiddleware } from '../middleware/auth';
import { toTodo } from '../mappers';
import { getTxid } from '../txid';
import { applyTodoInsert, applyTodoUpdate, applyTodoDelete } from '../services/todos';
import { ServiceError } from '../services/errors';

export const todoRoutes = new Hono<AppEnv>();

todoRoutes.use('*', authMiddleware);

todoRoutes.get('/', async (c) => {
  const user = c.get('user');
  const rows = await db
    .select()
    .from(todos)
    .where(eq(todos.userId, user.id))
    .orderBy(desc(todos.createdAt));
  return c.json(rows.map(toTodo));
});

todoRoutes.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{ id?: string; title?: string; dueDate?: string | null }>();
  try {
    // Wrap the write in a transaction so we can hand back its txid for Electric
    // sync matching. The mutation itself lives in the shared todo service.
    const { row, txid } = await db.transaction(async (tx) => {
      const txid = await getTxid(tx);
      const row = await applyTodoInsert(tx, user, body);
      return { row, txid };
    });
    return c.json({ ...toTodo(row), txid }, 201);
  } catch (e) {
    if (e instanceof ServiceError) return c.json({ error: e.message }, e.status);
    throw e;
  }
});

todoRoutes.patch('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json<{
    title?: string;
    completed?: boolean;
    dueDate?: string | null;
  }>();
  const { row, txid } = await db.transaction(async (tx) => {
    const txid = await getTxid(tx);
    const row = await applyTodoUpdate(tx, user, { id, ...body });
    return { row, txid };
  });
  if (!row) {
    return c.json({ error: 'Todo not found' }, 404);
  }
  return c.json({ ...toTodo(row), txid });
});

todoRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const { row, txid } = await db.transaction(async (tx) => {
    const txid = await getTxid(tx);
    const row = await applyTodoDelete(tx, user, { id });
    return { row, txid };
  });
  if (!row) {
    return c.json({ error: 'Todo not found' }, 404);
  }
  return c.json({ ok: true, txid });
});
