import type { UserRow, TodoRow } from '@app/db';
import type { User, Todo } from '@app/db/types';

export const toUser = (r: UserRow): User => ({
  id: r.id,
  name: r.name,
  role: r.role,
  createdAt: r.createdAt.toISOString(),
});

export const toTodo = (r: TodoRow): Todo => ({
  id: r.id,
  userId: r.userId,
  title: r.title,
  completed: r.completed,
  dueDate: r.dueDate?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
});
