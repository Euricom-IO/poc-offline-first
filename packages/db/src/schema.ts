import { pgTable, uuid, text, boolean, timestamp, bigint, pgEnum } from 'drizzle-orm/pg-core';

export const roleEnum = pgEnum('role', ['user', 'admin']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  pinHash: text('pin_hash').notNull(),
  role: roleEnum('role').notNull().default('user'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const todos = pgTable('todos', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  completed: boolean('completed').notNull().default(false),
  // Nullable: a todo without a deadline is the normal case, and the sync paths
  // need "no due date" and "due date cleared" to be the same value.
  dueDate: timestamp('due_date', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Ledger of applied offline-sync commands. Keyed by the client-generated event
 * id so a replayed command (committed on the server but whose response was lost)
 * is deduped: the events endpoint short-circuits and returns the original txid
 * instead of re-applying. Doubles as an audit trail of every applied command.
 */
export const processedEvents = pgTable('processed_events', {
  id: uuid('id').primaryKey(),
  entity: text('entity').notNull(),
  op: text('op').notNull(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  txid: bigint('txid', { mode: 'number' }).notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
});

export type UserRow = typeof users.$inferSelect;
export type TodoRow = typeof todos.$inferSelect;
export type ProcessedEventRow = typeof processedEvents.$inferSelect;
