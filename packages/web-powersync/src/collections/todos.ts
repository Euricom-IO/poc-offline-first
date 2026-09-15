import { createCollection } from '@tanstack/react-db';
import { powerSyncCollectionOptions } from '@tanstack/powersync-db-collection';
import { z } from 'zod';
import { db, APP_SCHEMA } from '@/lib/powersync';

/**
 * Todos as an optimistic TanStack DB collection backed by PowerSync.
 *
 * SQLite has no boolean/timestamp types, so the stored row keeps `completed` as
 * an integer (0/1) and `created_at`/`due_date` as ISO text, while the app works
 * with `boolean`/`Date`. `due_date` is additionally nullable — a todo with no
 * deadline. Three pieces bridge that gap:
 *
 * - `schema` validates what the app writes and reads, so its input and output
 *   are BOTH the rich types. It must be idempotent: on `update` TanStack DB
 *   re-validates the row it already holds (already transformed) merged with the
 *   changed fields, so a `string -> Date` transform here would reject the
 *   untouched `created_at` of every single update.
 * - `deserializationSchema` converts rows arriving from the sync stream (raw
 *   SQLite values) into those rich types.
 * - `serializer` converts the rich types back to SQLite values on write.
 */
const todoSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  title: z.string(),
  completed: z.boolean(),
  due_date: z.date().nullable(),
  created_at: z.date(),
});

/** Raw SQLite row (sync stream / local reads) -> rich output types. */
const todoDeserializationSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  title: z.string(),
  completed: z.number().transform((value) => value > 0),
  // Nullable, not nullish: the column is declared in APP_SCHEMA, so the local
  // view always projects it and a row that predates it reads back as NULL
  // rather than as a missing key.
  due_date: z
    .string()
    .nullable()
    .transform((value) => (value ? new Date(value) : null)),
  created_at: z.string().transform((value) => new Date(value)),
});

/** A todo as read from — and written to — the collection. */
export type Todo = z.output<typeof todoSchema>;

/**
 * Serialize a timestamp the way the replication stream delivers one.
 *
 * PowerSync replicates Postgres `timestamptz` as ISO text with MICROSECOND
 * precision (`2026-09-19T22:00:00.000000Z`); `Date.toISOString()` emits
 * milliseconds (`…000Z`). The core's update trigger diffs the *stored text*
 * against the newly serialized text, so the shorter form reads as a change and
 * the column is re-sent on every write, whether or not it was touched.
 *
 * For `due_date` that is a correctness bug, not just noise: `applyTodoUpdate`
 * acts on `dueDate`, so ticking a checkbox would re-send a possibly stale
 * deadline and silently overwrite another client's concurrent edit to it.
 * Padding to six digits makes an untouched due date diff equal — exact here
 * because every value the UI produces is a whole second (local midnight).
 *
 * `created_at` is deliberately left on `toISOString()`: Postgres keeps
 * sub-millisecond digits that a JS `Date` cannot represent, so no padding makes
 * it compare equal — and it does not matter, because the services never read
 * `created_at` from an update payload.
 */
function toStreamIsoText(value: Date): string {
  return value.toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
}

export const todoCollection = createCollection(
  powerSyncCollectionOptions({
    database: db,
    table: APP_SCHEMA.props.todos,
    schema: todoSchema,
    deserializationSchema: todoDeserializationSchema,
    onDeserializationError: (error) => {
      console.error('[todos] failed to deserialize a synced row', error);
    },
    serializer: {
      completed: (value) => (value ? 1 : 0),
      due_date: (value) => (value ? toStreamIsoText(value) : null),
      created_at: (value) => value.toISOString(),
    },
  }),
);
