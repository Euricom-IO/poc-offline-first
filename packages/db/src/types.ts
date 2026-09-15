// Pure DTO types shared across the API and the web client.
// No runtime dependencies here so the browser bundle stays free of drizzle/postgres.

export type Role = 'user' | 'admin';

export interface User {
  id: string;
  name: string;
  role: Role;
  createdAt: string;
}

export interface Todo {
  id: string;
  userId: string;
  title: string;
  completed: boolean;
  /** ISO timestamp, or null when the todo has no deadline. */
  dueDate: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Offline sync commands (event store). A client mutation is captured as one
// SyncCommand, queued durably, and replayed to POST /api/events. The `id` is a
// client-generated uuid used as the idempotency key so a command that committed
// on the server but whose response was lost can be safely retried.
// ---------------------------------------------------------------------------

export type SyncEntity = 'todo' | 'user';
export type SyncOp = 'insert' | 'update' | 'delete';

export interface SyncCommand {
  id: string;
  entity: SyncEntity;
  op: SyncOp;
  payload: Record<string, unknown>;
  createdAt: string;
}
