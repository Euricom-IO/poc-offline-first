import { createCollection } from '@tanstack/react-db';
import { powerSyncCollectionOptions } from '@tanstack/powersync-db-collection';
import { z } from 'zod';
import { db, APP_SCHEMA } from '@/lib/powersync';

/**
 * Todos as an optimistic TanStack DB collection backed by PowerSync.
 *
 * SQLite has no boolean/timestamp types, so the stored row keeps `completed` as
 * an integer (0/1) and `created_at` as ISO text, while the app works with
 * `boolean`/`Date`. Three pieces bridge that gap:
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
  created_at: z.date(),
});

/** Raw SQLite row (sync stream / local reads) -> rich output types. */
const todoDeserializationSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  title: z.string(),
  completed: z.number().transform((value) => value > 0),
  created_at: z.string().transform((value) => new Date(value)),
});

/** A todo as read from — and written to — the collection. */
export type Todo = z.output<typeof todoSchema>;

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
      created_at: (value) => value.toISOString(),
    },
  }),
);
