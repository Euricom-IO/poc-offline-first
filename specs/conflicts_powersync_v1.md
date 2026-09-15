# Conflict Resolution on the `web-powersync` Path

Scope: `packages/web-powersync` + the `/api/data` write endpoint + the shared
services it calls. `web` and `web-electric` appear only where the contrast is
load-bearing (the dead-letter story).

Everything below was verified against the SDK actually on disk —
`@powersync/common` **1.57.3** (via `@powersync/web` **1.39.1**), whose bundled
Rust core reports **`powersync-sqlite-core 0.4.10`** (string present in
`node_modules/.bun/@powersync+web@1.39.1*/dist/worker/SharedSyncImplementation.umd.js`).
Where a claim comes from reading source rather than documentation, it is
labelled as such.

---

## 1. The crux: `/api/data` answers `400`, and on this path that is never correct

`packages/api/src/routes/data.ts:190-194`:

```ts
} catch (e) {
  const message = e instanceof Error ? e.message : 'unknown error';
  console.error('❌ [data] batch failed:', message);
  return c.json({ error: `Request failed: ${message}` }, 400);
}
```

Every failure — a transient Postgres blip, a `ServiceError(403, 'admin role
required')`, a `ServiceError(409, 'A user with that name already exists')` —
collapses into one flat `400`. `packages/web-powersync/src/lib/api.ts:35-38`
throws `ApiError` on any non-2xx, so `uploadData`
(`packages/web-powersync/src/lib/powersync.ts:161-173`) throws before reaching
`batch.complete()`, and the batch stays in `ps_crud`.

PowerSync's documentation is unusually blunt about this being the wrong shape.
From [Writing Client Changes → Recommendations](https://docs.powersync.com/handling-writes/writing-client-changes):

> 2. Use an error response (`5xx`) only when the write operations cannot be applied due to a temporary error (e.g. backend source database not available). In this scenario, the PowerSync Client SDK can retry uploading the write operation and it should succeed at a later time.
> 3. For validation errors or write conflicts, you should avoid returning an error response (`4xx`), since it will block the PowerSync client's upload queue. Instead, it is best to return a `2xx` response, and if needed, propagate the validation or other error message(s) back to the client.

And from [Handling Write / Validation Errors](https://docs.powersync.com/handling-writes/handling-write-validation-errors):

> The backend should respond with "success" (HTTP 2xx) even in the case of write conflicts or validation failures, unless developer intervention is desired.
>
> Error responses should be reserved for:
>
> 1. Network errors.
> 2. Temporary server errors (e.g. high load, or database unavailable).
> 3. Unexpected bugs or schema mismatches, where the change should stay in the client-side queue.

And from [Client-Side Integration → Error Handling](https://docs.powersync.com/configuration/app-backend/client-side-integration):

> If your `uploadData()` throws an error (e.g. due to a `4xx` or `5xx` response from your backend), the SDK will **retry** the same upload indefinitely, effectively blocking the upload queue.

So the repo's `400` is doing exactly the opposite of what it reads like it is
doing: it is not "reject this op", it is "keep this op forever and stop the
client". Worse, `/api/data` also hands `400` to the genuinely transient cases,
where the retry _is_ wanted — the status carries no information either way.

**Which ops can actually poison the queue today** (walked from the services):

| Trigger                         | Thrown                                 | Reachable from the UI?                                     |
| ------------------------------- | -------------------------------------- | ---------------------------------------------------------- |
| Non-admin edits a user          | `ServiceError(403)` — `data.ts:120`    | Yes, if a non-admin ever gets a `users` write queued       |
| Duplicate user name             | `ServiceError(409)` — `users.ts:37,44` | Yes — admin page, two clients adding the same name offline |
| `applyUserDelete` of self       | `ServiceError(400)` — `users.ts:77`    | Yes                                                        |
| Empty todo title on insert      | `ServiceError(400)` — `todos.ts:48`    | Guarded in the route, so only via a stale/edited queue     |
| FK violation on `todos.user_id` | Postgres error                         | Only if the user row is gone                               |

Todos are comparatively safe; `users` is where a permanently-stuck queue is a
realistic accident. Both share one CRUD queue, so a poisoned `users` op stops
todo sync too.

Note the one place `/api/data` already gets the shape right — unknown tables are
logged and skipped (`data.ts:167-170`) rather than failing the batch. That is
precisely the "acknowledge and discard" the docs want, applied to exactly one
case.

Contrast `web-electric`, which classifies: `syncEngine.ts:104-108` treats
4xx-minus-408/429 as terminal and dead-letters it, so a bad command leaves the
FIFO instead of blocking it. That option does not exist on the PowerSync path
(see §4), which is why the backend has to carry the whole burden.

---

## 2. There is no concurrency token — and that is the prescribed design, not a gap

**Claim 1 — confirmed.** `packages/db/src/schema.ts:13-24`:

```ts
export const todos = pgTable("todos", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  completed: boolean("completed").notNull().default(false),
  dueDate: timestamp("due_date", { withTimezone: true }), // added by 0002
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
```

No `version`, no `updated_at`. `users` (`schema.ts:5-11`) likewise has only
`created_at`. No migration (`0000_init.sql`, `0001_powersync_publication.sql`,
`0002_clammy_star_brand.sql`) adds one. There is no concurrency token anywhere
in the source database.

`due_date` is _not_ one, despite being a timestamp: it is a user-chosen
deadline, never touched by the write path, so it says nothing about when the row
was last modified. Strategy 3's `*_modified_at` columns would still
have to be added separately.

**Claim 2 — confirmed.** `packages/api/src/services/todos.ts:96-101`:

```ts
const [row] = await tx
  .update(todos)
  .set(patch)
  .where(and(eq(todos.id, id), eq(todos.userId, user.id)))
  .returning();
return row ?? null;
```

A blind `.set(patch)` scoped by `id` + `userId`. No predicate on prior state, so
a stale write silently wins and nothing anywhere records that it happened. And
the `onConflictDoNothing({ target: todos.id })` at `todos.ts:62` is idempotency
for replays — it makes a repeated `PUT` a no-op, which is what the docs ask for
("The operations must be idempotent") — not conflict handling.

**But the last-write-wins outcome is what PowerSync prescribes**, and the
granularity is better than it looks. [Handling Update Conflicts](https://docs.powersync.com/handling-writes/handling-update-conflicts):

> By design PowerSync is unopinionated when it comes to handling conflicts on the backend. … The developer's app backend therefore dictates how mutations from clients are processed and applied against the source database. PowerSync then replicates and syncs those mutations back to the client. This is known as server-authoritative reconcilliation.
>
> In the simplest backend implementation, the behavior of the overall system will be per-field Last-Write-Wins (LWW).
>
> 1. Deletes always win: If one client deletes a row, any future updates to that row are ignored. The row may be created again with the same ID.
> 2. For multiple concurrent updates, the last update (as received by the server) to each individual field wins.

Two things this repo already gets right, by construction rather than by design:

**Per-field, not per-row.** A `PATCH` carries only the columns that actually
changed, and `applyTodoUpdate` only builds `patch` keys for fields present in
the payload (`todos.ts:80-83`). So two clients editing different fields of the
same row both keep their edit. This is not the collection layer's doing — look
at `@tanstack/powersync-db-collection`'s `PowerSyncTransactor.handleUpdate`,
which writes the _whole_ modified row:

```sql
UPDATE todos SET id = ?, user_id = ?, title = ?, completed = ?, created_at = ? WHERE id = ?
```

The narrowing happens one layer down, in the SQLite view trigger the Rust core
generates ([`crates/core/src/views.rs`, v0.4.10](https://github.com/powersync-ja/powersync-sqlite-core/blob/v0.4.10/crates/core/src/views.rs)):

```rust
data: Some(&from_fn(|f| {
    write!(f, "json(powersync_diff({json_fragment_old}, {json_fragment_new}))")
})),
```

`powersync_diff(old, new)` returns only the keys whose values differ
([`crates/core/src/diff.rs`](https://github.com/powersync-ja/powersync-sqlite-core/blob/v0.4.10/crates/core/src/diff.rs)).
So the field-level diff is computed in SQLite and is free — read from source,
not documented at this level of detail.

**Deletes win.** `applyTodoUpdate` returns `null` when no row matched, and
`applyTodoOp` (`data.ts:69-84`) ignores the return value. A `PATCH` for a row
another client deleted is therefore a silent success — which is exactly rule 1.
Accidental, but correct. (It is also silent, which §6 argues is the thing to
change.)

---

## 3. `trackPrevious` / `previousValues`: available, cheap, and not what you think

**Claim 3 — confirmed, with corrections.**

The app schema (`packages/web-powersync/src/lib/powersync.ts:40-60`) sets
`trackMetadata: true` on both tables and does not set `trackPrevious`. The
option exists in the installed SDK — `@powersync/common@1.57.3`,
`src/db/schema/Table.ts`:

```ts
export interface TableOrRawTableOptions {
  localOnly?: boolean;
  insertOnly?: boolean;
  trackPrevious?: boolean | TrackPreviousOptions;
  trackMetadata?: boolean;
  ignoreEmptyUpdates?: boolean;
}

export interface TrackPreviousOptions {
  /** When defined, a list of column names for which old values should be tracked. */
  columns?: string[];
  /** When enabled, only include values that have actually been changed by an update. */
  onlyWhenChanged?: boolean;
}
```

and `CrudEntry.previousValues` exists in
`src/client/sync/bucket/CrudEntry.ts`. **The naming wart is real**: the SDK's own
doc comment on that field names an option that does not exist in the JS SDK —

```ts
/**
 * For tables where the `trackPreviousValues` option has been enabled, this tracks previous values for
 * `UPDATE` and `DELETE` statements.
 */
previousValues?: Record<string, any>;
```

`trackPreviousValues` is the Dart/Kotlin/Swift spelling; the JS type is
`trackPrevious`. The docs confirm the split explicitly —
[JSON, Arrays and Custom Types](https://docs.powersync.com/client-sdks/advanced/custom-types-arrays-and-json):

> `trackPreviousValues` (or `trackPrevious` in our JS SDKs): Access previous values for diffing JSON or array fields. Accessible later via `CrudEntry.previousValues`.

**No migration is required.** Confirmed: the option is encoded into the schema
JSON handed to the core (`src/db/schema/internal.ts`):

```ts
include_old: trackPrevious && ((trackPrevious as any).columns ?? true),
include_old_only_when_changed: typeof trackPrevious == 'object' && trackPrevious.onlyWhenChanged == true,
```

The core regenerates the view triggers from that; nothing is added to the source
Postgres schema and nothing is added to the local table either — `old` is just
another JSON field written into the existing `ps_crud.data` blob. So "detection
with no database migration" is accurate.

### What actually lands in `previousValues`

Not documented. Read from
[`crates/core/src/utils/sql_buffer.rs`, v0.4.10](https://github.com/powersync-ja/powersync-sqlite-core/blob/v0.4.10/crates/core/src/utils/sql_buffer.rs),
`insert_into_powersync_crud`:

```rust
let old_values = if insert.op == WriteType::Insert {
    // Inserts don't have previous values we'd have to track.
    None
} else {
    match &options.diff_include_old {
        None => None,
        Some(include_old) => {
            let old_values = table_columns_to_json_object_with_filter("OLD", insert.table, include_old.column_filter())?;
            if insert.op == WriteType::Update && options.flags.include_old_only_when_changed() {
                Some(format!("json(powersync_diff({filtered_new_fragment}, {old_values}))"))
            } else {
                Some(old_values)
            }
        }
    }
};
```

| Op       | `opData`                                              | `previousValues`                                                                                                                                                                       |
| -------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUT`    | all non-null columns (`powersync_diff('{}', new)`)    | **never set** — inserts have no old values                                                                                                                                             |
| `PATCH`  | only the changed columns (`powersync_diff(old, new)`) | full OLD row, filtered by `columns`; with `onlyWhenChanged`, only the OLD values of columns that changed (note the argument order is `powersync_diff(new, old)`, i.e. the mirror diff) |
| `DELETE` | nothing (only `id`)                                   | full OLD row, filtered by `columns`. `onlyWhenChanged` does **not** apply — the condition is `op == Update`                                                                            |

- `ignoreEmptyUpdates` / `ignore_empty_update`: the crud vtab drops a `PATCH`
  whose data is exactly `{}` ([`crates/core/src/crud_vtab.rs`](https://github.com/powersync-ja/powersync-sqlite-core/blob/v0.4.10/crates/core/src/crud_vtab.rs)):
  `if flags.ignore_empty_update() && op == "PATCH" && data.map(|r| r.get()) == Some("{}")`.
  Docs say only "`ignoreEmptyUpdates`: Skips updates when no data has actually
  changed." Relevant here: the collection writes every column on update, so an
  idempotent write would otherwise queue a no-op `PATCH` — which
  `applyTodoUpdate` already special-cases at `todos.ts:88-94`. Turning this on
  would make that dead code.

### Docs are silent on the thing we would actually want

- **`onlyWhenChanged` and the `columns` filter are not documented at all.** The
  only prose is the one-line bullet above. Their semantics here come from the
  Rust source.
- **Compare-and-set against `previousValues` is nowhere documented as an
  intended use.** Every doc mention frames `previousValues` as _diffing JSON and
  array columns_ — "compare the previous and new values to process only the
  changes you care about, which is particularly useful for tracking changes to
  JSON and array fields." Using it as an optimistic-concurrency token would be
  **a use we are inventing**, not one PowerSync sanctions.
- Where PowerSync _does_ document conflict detection
  ([Custom Conflict Resolution](https://docs.powersync.com/handling-writes/custom-conflict-resolution)),
  every strategy adds a column: Strategy 1 a `modified_at` timestamp, Strategy 2
  a `version BIGSERIAL`, Strategy 3 per-field `*_modified_at` columns. None of
  them use `previousValues`.
- That same page is **wrong about the field name**. Its `CrudEntry` interface
  reads `trackPrevious?: Record<string, any>; // Previous values (trackPrevious)`
  — there is no such field; it is `previousValues`. Treat that page's type block
  as unreliable.

**Would it be sufficient for detection without a version column?** For this
schema, yes, mechanically: `previousValues` gives the server the client's view
of the row before its edit, so `UPDATE todos SET completed = $new WHERE id = $id
AND completed = $old` is expressible, and `rowCount === 0` is a detected
conflict. Two caveats:

1. It is an ABA detector, not a version detector. `completed` has two states, so
   "someone else toggled it and toggled it back" is undetectable, and — worse —
   "someone else set it to the same value I did" reads as a conflict when
   nothing was lost. That weakness scales with how few values a
   field has, so it is near-total on `completed` and negligible on the `title`
   text added since: two users independently typing the same replacement string
   is not a case worth designing around. An ABA detector is a poor concurrency
   token in general and a perfectly good one for free text — which is why §6's
   phase 2 scopes it to `title` alone.
2. `previousValues` is **not currently forwarded to the server**. `toUploadOp`
   (`powersync.ts:130-139`) builds `{ op, table, id, data, metadata }` and drops
   `entry.previousValues`. Enabling `trackPrevious` alone changes nothing on the
   wire.

---

## 4. The rejection problem: what the client can actually do

This is the part where the answer is narrower than it looks.

### Is `batch.complete()` on a rejected batch the sanctioned discard?

Half right, and the half that is wrong matters. The sanctioned flow is not
"server says no, client discards" — it is **"server discards and says yes"**.
[Consistency → Validation and Conflict Handling](https://docs.powersync.com/architecture/consistency)
lists the backend's options for a mutation it cannot apply:

> - Discard the mutation.
> - Discard the entire transaction.
> - Re-create the row.
> - Record the failed mutation elsewhere, potentially notifying the user and allowing the user to resolve the issue.

and

> 4. If it is acceptable to lose some mutations due to constraint errors:
>    1. Discard the mutation, or the entire transaction if the changes must all be applied together.
>    2. Implement error notifications to detect these issues.

The client's `complete()` is then the ordinary success path — it is only ever
called after a 2xx, and the current code already does the right thing
(`powersync.ts:168-172`). There is no documented client-side "discard this
doomed op" gesture, because the design does not have one. The docs go further
and rule the idea out ([Handling Write / Validation Errors](https://docs.powersync.com/handling-writes/handling-write-validation-errors)):

> While the client could implement a dead-letter queue, this is not recommended, since this cannot easily be inspected by the developer. The information is also often not sufficient to present to the user in a friendly way or to allow manual conflict resolution.

Mechanically nothing stops us calling `complete()` after a 4xx. The SDK would
accept it — `handleCrudCheckpoint`
(`@powersync/common@1.57.3`, `src/client/AbstractPowerSyncDatabase.ts:854-868`)
just deletes the rows. But it is a client-side dead-letter, and it is the thing
the docs name and reject.

### Can a _single_ op be parked or dropped?

**No.** From the installed SDK:

```ts
// src/client/AbstractPowerSyncDatabase.ts
private async handleCrudCheckpoint(lastClientId: number, writeCheckpoint?: string) {
  return this.writeTransaction(async (tx) => {
    await tx.execute(`DELETE FROM ${PSInternalTable.CRUD} WHERE id <= ?`, [lastClientId]);
    ...
```

`complete()` deletes a **prefix** of the queue — everything up to and including
the last entry of the batch. There is no selection, no per-entry acknowledgement,
no "skip this one".

The finest granularity available is a transaction, not an op:

- `getCrudBatch(limit = 100)` returns up to 100 entries which "may contain data
  from multiple transactions, and a single transaction may be split over
  multiple batches" (SDK doc comment). This is what `uploadData` uses today
  (`powersync.ts:162`).
- `getNextCrudTransaction()` / `getCrudTransactions()` return one local
  transaction at a time. `CrudTransaction extends CrudBatch` with
  `haveMore: false`, and its `complete()` is the same `handleCrudCheckpoint` —
  the SDK comment for the iterator says plainly: "Calling `CrudTransaction.complete`
  will mark that and all prior transactions emitted by the iterator as completed."

So even the transaction-scoped API cannot skip one op and keep the next.

### Does `complete()` take a write checkpoint argument?

Yes — `complete: (writeCheckpoint?: string) => Promise<void>`
(`src/client/sync/bucket/CrudBatch.ts`) — but it is **not** a discard control. It
is the legacy Custom Write Checkpoints feature:
[Data Pipelines](https://docs.powersync.com/handling-writes/custom-write-checkpoints)
describes it as "Legacy Custom Write Checkpoints — Pass the checkpoint number to
`transaction.complete()` in `uploadData()`", for backends that apply uploads
asynchronously. (It is also a paid-tier feature.) Passing it does not change
which entries are removed; see the branch in `handleCrudCheckpoint` — it only
decides whether `$local.target_op` is set to the supplied checkpoint or to
`MAX_OP_ID`.

### The honest answer

**The backend must never return an unresolvable error on this path.** There is
no client-side lever that rescues a queue the server has permanently refused, and
the one lever that exists (completing anyway) is the client-side dead-letter the
docs explicitly advise against. Every decision — apply, merge, discard, park
server-side — has to be made inside `/api/data`, and `/api/data` has to answer
2xx once it has made one. A `4xx` is only correct for "this is a bug, stop the
world and page me", which is a deliberate choice, not a fallback.

---

## 5. How local state converges — and yes, the user can watch their write revert

**Claim 5 — confirmed, with one refinement to the wording in `CLAUDE.md`.**

The documented rule ([Consistency](https://docs.powersync.com/architecture/consistency)):

> While mutations are present in the upload queue, the client does not advance to a new checkpoint. This means the client never has to resolve conflicts locally.
>
> Only once all the client-side mutations have been acknowledged by the server, and the data for that new checkpoint is downloaded by the client, does the client advance to the next checkpoint.

The implementation, in the core on disk
([`crates/core/src/sync_local.rs`, v0.4.10](https://github.com/powersync-ja/powersync-sqlite-core/blob/v0.4.10/crates/core/src/sync_local.rs)):

```rust
fn can_apply_sync_changes(&self) -> Result<bool, PowerSyncError> {
    // Don't publish downloaded data until the upload queue is empty (except for downloaded data
    // in priority 0, which is published earlier).
    ...
        let statement = self.db.prepare_v2(
            "SELECT 1 FROM ps_buckets WHERE target_op > last_op AND name = '$local'",
        )?;
        if statement.step()? == ResultCode::ROW { return Ok(false); }

        let statement = self.db.prepare_v2("SELECT 1 FROM ps_crud LIMIT 1")?;
        if statement.step()? != ResultCode::DONE { return Ok(false); }
```

Two gates: an outstanding write checkpoint, and a non-empty `ps_crud`.

**The refinement.** `CLAUDE.md` says "a blocked upload also stops downloads".
Strictly, the download stream keeps running and operations keep landing in
`ps_oplog` — what stops is _publishing_ them into `ps_data__*` and therefore into
the views the app queries. The core logs exactly that
([`crates/core/src/sync/streaming_sync.rs`](https://github.com/powersync-ja/powersync-sqlite-core/blob/v0.4.10/crates/core/src/sync/streaming_sync.rs)):

> `"Could not apply checkpoint due to local data. Will retry at completed upload or next checkpoint."`

Observationally `CLAUDE.md` is right — the client goes fully stale, which is
scenario 2 of the proxy README's Sync fault checklist — but the mechanism is
"downloaded and withheld", not "not downloaded". That distinction matters if you
ever try to diagnose it: the stream is healthy and `db.currentStatus.connected`
stays true, which is why `SyncStatus.tsx` has to report queue depth _and_
connection state.

### The convergence sequence, end to end

1. `uploadData` POSTs, gets 2xx, calls `batch.complete()`. `ps_crud` prefix is
   deleted and `$local.target_op` is set to `MAX_OP_ID` — i.e. the gate is
   slammed shut until a real write checkpoint is obtained.
2. The upload loop finds the queue empty and calls
   `adapter.updateLocalTarget(() => this.getWriteCheckpoint())`
   (`src/client/sync/stream/AbstractStreamingSyncImplementation.ts:419`), which
   issues `GET /write-checkpoint2.json?client_id=…` (line 358-365) and stores the
   returned op id as `$local.target_op`.
3. The service replicates; when a checkpoint arrives whose `write_checkpoint`
   reaches that target, `sync_local` sets `$local.last_op`, `can_apply_sync_changes`
   passes, and `SyncOperation::apply()` runs.
4. `apply()` recomputes every row named in `ps_updated_rows` — the table the crud
   vtab writes on _every local mutation_ — from `ps_oplog`:

   ```sql
   WITH updated_rows AS (
       SELECT b.row_type, b.row_id FROM ps_buckets AS buckets
           CROSS JOIN ps_oplog AS b ON b.bucket = buckets.id AND (b.op_id > buckets.last_applied_op)
       UNION ALL SELECT row_type, row_id FROM ps_updated_rows
   )
   ```

   Every locally-written row is `REPLACE`d from server state, or `DELETE`d if
   `ps_oplog` has nothing for it. That is the rollback: if the server discarded
   the write, `ps_oplog` never changed, and the local row is rewritten to the
   pre-edit value.

The docs describe the same thing from the outside
([Handling Write / Validation Errors → How Changes Are Rolled Back](https://docs.powersync.com/handling-writes/handling-write-validation-errors)):

> There is no explicit "roll-back" operation on the client — but a similar effect is achieved by the internals of PowerSync. … 4. If the local change was discarded by the server, the server state will not change, and the client will revert to the last known state. 5. If another conflicting write "won", that write will be present in the server state, and will overwrite the local changes.

**Can a user see their own write visibly revert? Yes**, and PowerSync says so —
[Writing Client Changes](https://docs.powersync.com/handling-writes/writing-client-changes),
"Why must my write endpoint be synchronous?":

> if the client believes that the server has written changes into your backend source database … but the next checkpoint does not contain your uploaded changes, those changes will be removed from the client. This could manifest as UI glitches for your end-users, where the changes disappear from the device for a few seconds and then re-appear.

**How quickly**: one upload round-trip plus one write-checkpoint round-trip plus
replication lag. `uploadData` is throttled at `crudUploadThrottleMs` (JS default
1000ms) and retried at `retryDelayMs` (default 5000ms) —
`src/client/sync/stream/AbstractStreamingSyncImplementation.ts:218-229`. In
practice: a second or two on a healthy connection. Fast enough to read as a
flicker, slow enough to be noticed.

For this app, concretely: two clients toggle the same todo. Both see it flip
instantly. `/api/data` applies both in arrival order. The loser's checkbox flips
back a second or so later, with no explanation anywhere in the UI.

The same sequence on `title` is materially worse. Two clients rename the same
todo; the loser watches their own sentence be replaced by someone else's, a second after they pressed save, with no explanation and no
copy of what they wrote. A checkbox flipping back reads as a glitch a user will
shrug at and redo; text changing under them reads as data loss, because it is.
This is the single strongest argument for step 3's conflict record, and the
reason phase 2 in §6 keeps the overwritten text rather than just flagging that a
clash happened.

---

## 6. Recommendation: keep LWW, stop hiding it, and make `/api/data` answer `2xx`

**Argued position: (c) — accept last-write-wins and make conflicts visible —
with the emphasis on the second half.** Not (a), not (b).

### Why not (b), compare-and-set with rejection

It is the option `previousValues` makes technically cheap, and it is the wrong
one here, for three independent reasons:

1. **It is the wrong detector for the field users touch most.** A CAS on
   `completed` fires when the other client set it to the _same_ value, which
   loses nothing, and misses a double toggle entirely — mostly false positives on
   a two-state field. That argument does **not** extend to the rest of the row:
   `todos.tsx` has a real edit path (`startEdit`/`saveEdit`) writing `title` and
   `due_date`, and a concurrent edit to a free-text `title` destroys something a
   user actually typed, which is the textbook case for detection. **On `title`,
   CAS would be a true detector** — so this reason narrows the scope of (b)
   rather than killing it, and the decision rests on reasons 2 and 3. See the
   phase-2 subsection below.

2. **Rejection has nowhere to go.** Per §4, a rejection cannot be a `4xx`, so it
   would have to be a `2xx` carrying a conflict payload — at which point we have
   built all the machinery of (c) anyway, and the detector is an addition on top
   rather than an alternative to it.
3. **It contradicts rule 1.** "Deletes always win" is what the current
   `applyTodoUpdate`-returns-`null` behaviour gives for free. CAS against a
   deleted row would turn the prescribed outcome into an error case.

### Why not (a), explicit field-level LWW via the PATCH diff

Because **we already have it** (§2) and adding a mechanism would be a no-op with
a maintenance cost. PowerSync's documented Strategy 3 (per-field
`*_modified_at` columns, resolved server-side) exists to fix _ordering_ — to make
the winner the client who edited last in wall-clock time rather than the client
whose packet arrived last. That is a real improvement for long offline windows,
and it costs three columns per table, a migration, per-field timestamp plumbing
through `_metadata`, and clock-skew exposure the docs warn about explicitly:

> Timestamps can be unreliable if servers have **clock skew**. … For critical data, use sequence numbers instead.

For a todo checkbox, "whoever the server heard last" and "whoever tapped last"
are indistinguishable to the user. The cost buys nothing here.

With three independently mutable fields the free field-level diff does real
work rather than being a technicality: one client renaming a todo and another
ticking it off do not collide, because the two PATCHes carry disjoint column
sets. This was **measured, not inferred** — the uploaded batches
logged by `/api/data` were read for each case. `saveEdit` assigns _both_ `title`
and `due_date` on every save, and the narrowing happens below the collection, in
the core's update trigger (§2), not in the app.

**But the diff compares serialized text, and that is a trap worth its own
paragraph.** PowerSync replicates Postgres `timestamptz` with **microsecond**
precision (`2026-09-19T22:00:00.000000Z`), while `Date.toISOString()` emits
milliseconds (`…000Z`). The first `due_date` implementation serialized with
`toISOString()`, so the stored and serialized text never matched and **every
write re-sent `due_date` whether or not it had been touched** — a checkbox toggle
uploaded a PATCH containing the deadline. Because `applyTodoUpdate` acts on
`dueDate`, that is not cosmetic: it silently overwrites another client's
concurrent due-date edit with a stale value, turning the disjoint-column-sets
property above into a lie. `collections/todos.ts` now pads to six digits
(`toStreamIsoText`) and the column drops out of untouched writes; verified by
toggling a checkbox and reading the resulting batch.

Two things follow. First, **the per-field LWW this section relies on is a
property of the serializer, not a guarantee of the platform** — it holds only
while every serialized value is byte-identical to what the stream delivers, and
nothing type-checks that. Second, `created_at` still fails this test and is
re-sent on every write, harmlessly only because the services never read it from
an update payload. Give `created_at` meaning server-side and it becomes the same
bug.

### What (c) actually means in this repo

Four changes, in the order they should land:

1. **`/api/data` must answer `2xx` for any decision it has made.** Replace the
   blanket `catch → 400` (`data.ts:190-194`) with a classification:
   - `ServiceError` → the backend has decided. Record it, **do not** rethrow,
     answer `200` with a per-op result.
   - anything else (Postgres unavailable, bug) → `5xx`, so the SDK retries, which
     is what `5xx` is reserved for.

   This is the single highest-value change on this path and is independent of
   any conflict policy. It also fixes the poison-op table in §1 outright.

2. **Return per-op results in the 2xx body.** `updateBatch` already iterates
   with an index (`data.ts:151`); have it collect
   `{ index, op, table, id, outcome: 'applied' | 'noop' | 'rejected', reason? }`.
   Today `applyTodoUpdate` returning `null` (row deleted, or not yours) is
   discarded at `data.ts:75-77` — that is the _correct_ LWW outcome and it should
   be reported rather than swallowed.

3. **Surface it.** The cheap version: `uploadData` logs rejections and
   `SyncStatus.tsx` grows a third state. The right version, and the one the docs
   actually recommend, is
   [Strategy 5 — Server-Side Conflict Recording](https://docs.powersync.com/handling-writes/custom-conflict-resolution):
   a `write_conflicts` row written by the backend, synced back down through the
   existing stream, rendered as a banner. Note that this fits the repo's
   `powersync/sync-config.yaml` as-is, which streams whole tables globally — no
   sync-rule work, just a table and a migration. It also does not need
   `previousValues`: the backend has the client's `opData` and its own row, which
   is both versions.

4. **Do not enable `trackPrevious` in phase 1.** It buys nothing here: step 3
   needs only the client's `opData` and the server's own row, which is already
   both versions. It earns its place only in phase 2 below, strictly _after_
   steps 1–3, for the sequencing reason in §8.

### Phase 2, only once steps 1–3 are in: CAS on `title` alone

An extension of the recommendation, not a reversal of it, and **⚠️ strictly gated
on server-side dead-lettering** (§8).

- **Scope it to `title`.** `completed` keeps plain LWW for the ABA reason above;
  `due_date` is cheap for a user to re-enter. Only free text is worth guarding.
- **Enable `trackPrevious: { columns: ['title'], onlyWhenChanged: true }`** on
  the `todos` table in `APP_SCHEMA`, and — the step that is easy to miss — make
  `toUploadOp` (`powersync.ts:130-139`) forward `entry.previousValues`, which it
  currently drops. Per §3 this needs **no migration and no version column**.
- **Compare server-side in `applyTodoUpdate`**: if `previousValues.title` is
  present and differs from the stored title, the client edited from a base that
  no longer exists.
- **Then still apply the write and report it** — do not reject. The user's text
  is the thing worth keeping; what CAS buys is knowing _whose_ text was replaced,
  so the `write_conflicts` row from step 3 can carry both versions and offer the
  loser a restore. Rejecting instead would discard a write the user watched
  succeed, which §5 shows is the worst-feeling outcome available.
- **Two caveats from §3, restated because they bite here.** `previousValues` is
  never populated for `PUT`, so a replayed insert is unaffected and must not be
  treated as a missing base. And using `previousValues` as a concurrency token
  is **not a documented use** — every documented detection strategy adds a
  column. This would be us inventing it, and it would need its own scenario in
  the proxy checklist.

### What this policy costs, stated plainly

- A write can still be silently overwritten between the moment it is made and the
  moment the banner appears. LWW loses writes; that is the deal. The _size_ of
  the loss varies sharply by field: a clobbered checkbox is one tap to redo, a
  clobbered title is prose the user has to remember and retype. Phase 2 exists
  because that gap is real, and step 3's conflict record should keep the
  overwritten `title` for exactly that reason.
- Two clients editing different fields both win, which is right for todos and
  would be wrong for anything with a cross-field invariant. If this app ever
  grows one (a status machine, a quantity), (a) or (b) becomes live again — and
  at that point the per-field-timestamp strategy, not CAS, is the one that fits
  a PowerSync queue.
- "Conflict visible" is retrospective, not preventive. There is no way to make
  it preventive without blocking local writes, which defeats the point.

---

## 7. Where this contradicts `specs/sync_v2.md` "Conflict handling"

`sync_v2.md` is a design for the `web-electric`-style engine — a client-owned
durable queue of application-level events. Several of its load-bearing
prescriptions are not merely unimplemented on the PowerSync path; they are
**actively harmful there**. This section is not "we haven't got to it yet".

**1. "Conflicts are a business rejection with a structured code."**

> The generic engine should treat conflicts as a business rejection with a structured code such as `version_conflict`. That lets clients distinguish retriable transport failures from domain-level merge work. (`sync_v2.md:1130`)

The transport in `sync_v2` is `syncState: data.code === 'version_conflict' ? 'conflict' : 'rejected'` (`sync_v2.md:481`) — i.e. an error response the client classifies. On the PowerSync path an error response of any kind blocks the queue forever. The structured code has to ride inside a **`2xx`**, and the client cannot act on it by changing an op's state, because ops have no state (see 3).

**2. A `409` is a correct answer.**

`sync_v2.md:1479` returns `409 hash_conflict`; `sync_improvements_v1.md` treats 4xx-as-terminal as the desired classification. That is right for `web-electric`, whose `syncEngine.ts:104-108` dead-letters 4xx. On `/api/data` a `409` is a permanent queue stall. **The same status code means opposite things on the two paths** — this is the single most important thing to know before sharing service code between them, and today `applyUserInsert` throws `ServiceError(409)` into both.

**3. The client event lifecycle (`conflict`, `rejected`, `dead_letter`).**

`sync_v2.md:156` specifies a per-event state machine including `conflict` ("Requires merge or user/system policy") and `dead_letter` ("Give up automated retry"). PowerSync's `ps_crud` has exactly two states: present, or deleted by `complete()`. There is no per-op status column, no `attempts`, no lease, and — per §4 — no API that could set one. **A client-side dead-letter is not just absent, it is advised against**: "While the client could implement a dead-letter queue, this is not recommended."

**4. `baseVersion` optimistic concurrency.**

The `EventEnvelope` carries `baseVersion?: number | null` (`sync_v2.md`, event model) so the server can reject a stale write. PowerSync CRUD entries are generated by SQLite triggers from the row diff; the application never constructs them. The only channels for app-supplied context are `_metadata` (already carrying the user pin) and `previousValues`. There is no envelope to put a `baseVersion` in.

**5. "The sync engine should not hard-code the policy."**

> The sync engine should not hard-code the policy, but it should make the conflict visible as a first-class outcome. (`sync_v2.md:1139`)

PowerSync hard-codes half of it. The client _always_ converges to server state —
`can_apply_sync_changes` + `ps_updated_rows` guarantee the local row is
overwritten, and no connector hook intercepts that. Policy is a backend-only
concern. The second half of the sentence survives intact and is exactly what §6
recommends.

**6. Where `sync_v2` is still right.** Idempotent replay
(`onConflictDoNothing`, already done), client-generated ids (already done), and
the insistence that a rejection is a first-class outcome that must be _recorded
durably_ — which on this path means `write_conflicts` in Postgres, not IndexedDB
on the client.

---

## 8. Conclusions that depend on adding dead-lettering first

Read "dead-lettering" here as the **server-side** variety the docs describe —
`/api/data` persisting an unapplicable op somewhere and answering `2xx` — not the
client-side kind, which is ruled out.

> Optionally, the server can implement a "dead-letter queue": If a change cannot be processed due to a conflict, schema mismatch and/or bug, the change can be persisted in a separate queue on the backend. This can then be manually inspected and processed by the developer or administrator, instead of blocking the client. ([Handling Write / Validation Errors](https://docs.powersync.com/handling-writes/handling-write-validation-errors))

**⚠️ Depends on dead-lettering — do not do these first:**

- **⚠️ Any server-side conflict _detection_ at all.** CAS, timestamp checks,
  business-rule validation — each one creates a new class of op that cannot be
  applied. Adding detection before there is somewhere for a detected conflict to
  go converts "silently wrong data" into "permanently frozen client", which is
  strictly worse. §6's argument against (b) is partly an argument about
  sequencing. This explicitly covers §6's phase-2 CAS on `title`: it is the most
  tempting thing to reach for once users can lose typed text, and the thing most
  likely to freeze a client if it lands first.
- **⚠️ Enforcing the `users` admin boundary on the sync path.** `data.ts:120`'s
  `ServiceError(403)` is correct security and a latent queue-killer. It can only
  stay once a 403 can be answered `2xx`-with-rejection.
- **⚠️ Tightening `applyTodoUpdate` / `applyUserUpdate`.** Both currently
  special-case an empty patch into a no-op precisely to avoid a terminal error
  (`todos.ts:85-94`) — a workaround for the missing dead-letter. Removing the
  workaround needs the real fix first.
- **⚠️ Strategy 5's `write_conflicts` table.** Recording a conflict is only
  useful if the op that caused it leaves the queue.
- **⚠️ Proxy checklist scenario 4** ("Poison message — the head-of-line block")
  currently documents the _expected_ behaviour as a permanent block. It should
  be rewritten to expect "op acknowledged, conflict recorded, queue drains" — but
  only after the change, or the checklist stops matching reality.

**Safe to do independently of dead-lettering:**

- Splitting the blanket `400` into `5xx` (transient) vs. `2xx` (decided) — this
  _is_ the first half of dead-lettering and is the prerequisite for everything
  above.
- Per-op results in the response body (nothing depends on them).
- The `SyncStatus.tsx` / logging surface for rejections.
- Documenting the 409-means-opposite-things hazard in the shared services.

---

## 9. Claim verification summary

| #   | Claim                                                                                                                                                                                            | Verdict                                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `todos`/`users` have no `version` or `updated_at`; no concurrency token anywhere                                                                                                                 | **Confirmed** — `schema.ts:5-24`, both migrations                                                                                                                                                                                                                                                         |
| 2   | `applyTodoUpdate` is a blind `.set(patch)` scoped by `id` + `userId`; `onConflictDoNothing` is idempotency, not conflict handling                                                                | **Confirmed** — `todos.ts:96-101`, `todos.ts:62`. Added: the LWW this produces is _per-field_ (the core diffs in SQLite), and "deletes win" already falls out of the `null` return                                                                                                                        |
| 3   | `trackMetadata` set, `trackPrevious` not; SDK 1.57.3 exposes `trackPrevious` (`boolean \| { columns?, onlyWhenChanged? }`) and `CrudEntry.previousValues`; no migration needed; naming wart real | **Confirmed in full** — `powersync.ts:40-60`, `Table.ts`, `CrudEntry.ts`, `internal.ts`. Corrections: `previousValues` is **never** populated for `PUT`; `onlyWhenChanged` does not apply to `DELETE`; `toUploadOp` drops `previousValues` today; the docs' own `CrudEntry` type block misnames the field |
| 4   | `/api/data` collapses everything into `400`; `uploadData` throws; no dead-lettering; permanent retry                                                                                             | **Confirmed** — `data.ts:190-194`, `api.ts:35-38`, `powersync.ts:168-172`, and the SDK's documented "retry the same upload indefinitely"                                                                                                                                                                  |
| 5   | A non-empty CRUD queue stops downloads; a stuck op freezes the client both ways                                                                                                                  | **Confirmed, wording refined** — `can_apply_sync_changes` in `sync_local.rs` gates on `ps_crud` _and_ `$local.target_op > last_op`. The stream stays connected and `ps_oplog` keeps filling; what is blocked is publishing into `ps_data__*`. Net effect on the user is as described                      |

## Sources

Primary documentation (docs.powersync.com):
[Handling Update Conflicts](https://docs.powersync.com/handling-writes/handling-update-conflicts) ·
[Handling Write / Validation Errors](https://docs.powersync.com/handling-writes/handling-write-validation-errors) ·
[Writing Client Changes](https://docs.powersync.com/handling-writes/writing-client-changes) ·
[Custom Conflict Resolution](https://docs.powersync.com/handling-writes/custom-conflict-resolution) ·
[Data Pipelines / Custom Write Checkpoints](https://docs.powersync.com/handling-writes/custom-write-checkpoints) ·
[Consistency](https://docs.powersync.com/architecture/consistency) ·
[PowerSync Protocol](https://docs.powersync.com/architecture/powersync-protocol) ·
[Client Architecture](https://docs.powersync.com/architecture/client-architecture) ·
[Client-Side Integration](https://docs.powersync.com/configuration/app-backend/client-side-integration) ·
[JSON, Arrays and Custom Types](https://docs.powersync.com/client-sdks/advanced/custom-types-arrays-and-json)

SDK source as installed (`@powersync/common` 1.57.3, mirrored at
[powersync-ja/powersync-js](https://github.com/powersync-ja/powersync-js/tree/main/packages/common)):
`src/db/schema/Table.ts`, `src/db/schema/internal.ts`,
`src/client/sync/bucket/CrudEntry.ts`, `CrudBatch.ts`, `CrudTransaction.ts`,
`SqliteBucketStorage.ts`, `src/client/AbstractPowerSyncDatabase.ts`,
`src/client/sync/stream/AbstractStreamingSyncImplementation.ts`,
`src/client/connection/PowerSyncBackendConnector.ts`.

Rust core as bundled (`powersync-sqlite-core` 0.4.10,
[tag v0.4.10](https://github.com/powersync-ja/powersync-sqlite-core/tree/v0.4.10)):
`crates/core/src/sync_local.rs`, `crates/core/src/views.rs`,
`crates/core/src/crud_vtab.rs`, `crates/core/src/diff.rs`,
`crates/core/src/utils/sql_buffer.rs`, `crates/core/src/sync/storage_adapter.rs`,
`crates/core/src/sync/streaming_sync.rs`.

Repo: `packages/api/src/routes/data.ts`, `packages/api/src/services/todos.ts`,
`packages/api/src/services/users.ts`, `packages/db/src/schema.ts`,
`packages/web-powersync/src/lib/powersync.ts`,
`packages/web-powersync/src/lib/api.ts`,
`packages/web-powersync/src/collections/todos.ts`,
`packages/web-powersync/src/routes/_authed/todos.tsx`,
`packages/web-electric/src/lib/syncEngine.ts`, `packages/proxy/README.md`,
`specs/sync_v2.md`, `specs/sync_improvements_v1.md`.
