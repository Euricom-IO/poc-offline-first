import { createCollection } from '@tanstack/react-db';
import { powerSyncCollectionOptions } from '@tanstack/powersync-db-collection';
import { z } from 'zod';
import { db, APP_SCHEMA } from '@/lib/powersync';

/**
 * Users as an optimistic TanStack DB collection backed by PowerSync (admin
 * page). The local table holds only the safe columns — `pin_hash` is never
 * synced to the client.
 *
 * As with the todos collection, `schema` describes the rich types the app reads
 * and writes (it has to accept its own output, because TanStack DB re-validates
 * the merged row on every `update`), and `deserializationSchema` turns the raw
 * SQLite row from the sync stream into those types.
 *
 * The write-only `pin` needed when creating a user or resetting a credential is
 * NOT a synced column: it is passed as PowerSync operation metadata
 * (`{ metadata: { pin } }`) and read back off the CrudEntry during upload.
 */
const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(['user', 'admin']),
  created_at: z.date(),
});

/** Raw SQLite row (sync stream / local reads) -> rich output types. */
const userDeserializationSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(['user', 'admin']),
  created_at: z.string().transform((value) => new Date(value)),
});

/** A user as read from — and written to — the collection. */
export type User = z.output<typeof userSchema>;

export const userCollection = createCollection(
  powerSyncCollectionOptions({
    database: db,
    table: APP_SCHEMA.props.users,
    schema: userSchema,
    deserializationSchema: userDeserializationSchema,
    onDeserializationError: (error) => {
      console.error('[users] failed to deserialize a synced row', error);
    },
    serializer: {
      created_at: (value) => value.toISOString(),
    },
  }),
);
