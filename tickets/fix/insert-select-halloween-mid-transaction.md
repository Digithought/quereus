---
description: Self-referential `INSERT ... SELECT` from the same table hits a halloween problem (iterator reads its own writes; integer arithmetic doubles row by row until `Number.isSafeInteger` rejects it) when the connection has a non-empty `pendingTransactionLayer` at the start of the statement — i.e. when there were prior writes earlier in the same explicit transaction. The recent statement-savepoint broadcast (`dml-executor-statement-savepoint-broadcast`) only fixed the autocommit / no-prior-writes path via the lazy-snapshot change in `MemoryTableConnection.createSavepoint`; when a pending layer already exists, the statement savepoint snapshots it but `pendingTransactionLayer` still points at the same mutable layer, and `MemoryTable.query()` walks the very layer the INSERT writes into.
files:
  - packages/quereus/src/vtab/memory/layer/connection.ts
  - packages/quereus/src/vtab/memory/table.ts
  - packages/quereus/src/runtime/emit/dml-executor.ts
---

# Mid-transaction self-referential INSERT...SELECT halloween regression

## Reproduction

Run with the current `fd` branch (or any branch with
`dml-executor-statement-savepoint-broadcast` merged):

```js
import { Database } from '@quereus/quereus';

const db = new Database();
await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val INTEGER)');

// Autocommit: works (lazy-snapshot path; pending layer null at savepoint)
await db.exec("INSERT INTO t VALUES (1, 10), (2, 20)");
await db.exec("INSERT INTO t (id, val) SELECT id + 100, val * 2 FROM t");
// → rows (1,10),(2,20),(101,20),(102,40) ✓

// Mid-transaction: fails. Pending layer is non-null at savepoint time,
// so `createTransactionSnapshot` clones it but `pendingTransactionLayer`
// is NOT replaced — the SELECT iterates the same mutable layer the
// INSERT writes into.
await db.exec('DELETE FROM t');
await db.exec('BEGIN');
await db.exec("INSERT INTO t VALUES (1, 10), (2, 20)");
await db.exec("INSERT INTO t (id, val) SELECT id + 100, val * 2 FROM t");
// → throws "Type mismatch for column 'val': expected INTEGER, got number"
//   (the iterator has been doubling the value 49–50 times before
//   `Number.isSafeInteger` rejects the runaway integer)
```

Same arithmetic signature as `test/logic/01.5-insert-select.sqllogic` test
#7 (the canonical case), but happens here because the connection's
`pendingTransactionLayer` was already populated by the BEGIN-time
`INSERT VALUES`.

## Why the prior fix didn't cover this

The `dml-executor-statement-savepoint-broadcast` implement-stage commit
(`cd6205f8`) made `MemoryTableConnection.createSavepoint` lazy: when
`pendingTransactionLayer` is `null` at savepoint time, push a null
marker instead of eagerly creating an empty layer. That makes the
statement savepoint a no-op on a clean connection — so a subsequent
SELECT reads from `readLayer` (the immutable committed layer) and is
not affected by writes into the freshly-created pending layer.

But when `pendingTransactionLayer` already exists at savepoint time
(prior writes in the same explicit transaction), `createSavepoint`
takes the eager branch:

```ts
const savepointLayer = this.pendingTransactionLayer
    ? this.createTransactionSnapshot(this.pendingTransactionLayer)
    : null;
this.savepointStack.push(savepointLayer);
```

`createTransactionSnapshot` builds a *separate immutable copy* and
pushes it onto the savepoint stack — but `this.pendingTransactionLayer`
still references the original mutable layer. Then in
`MemoryTable.query()`:

```ts
const startLayer = this.readCommitted ? conn.readLayer
    : (conn.pendingTransactionLayer ?? conn.readLayer);
```

…the SELECT iterates `pendingTransactionLayer`, which is the same layer
`processInsertRow` writes into during the row loop. Halloween problem.

The review-stage handoff for `dml-executor-statement-savepoint-broadcast`
describes the prior-writes case under "Known gaps / out-of-scope
follow-ups" #3 as a *perf* concern (`createTransactionSnapshot` cost
proportional to layer size). It's actually a correctness concern: the
SELECT reads the very writes the INSERT is producing.

## Expected behavior

Per SQL semantics, `INSERT ... SELECT` from the same table snapshots
the SELECT's source at statement start. The autocommit case already
does this (via the lazy-snapshot path). The mid-transaction case
should match.

## Likely fix directions (for the plan/implement stage to pick from)

These are sketches — none are decided.

1. **Snapshot-on-savepoint replacement.** On
   `createSavepoint` when `pendingTransactionLayer` is non-null, build
   the snapshot AND swap `pendingTransactionLayer` to point at the
   snapshot, so subsequent writes go into a fresh child layer
   inheriting from the (now immutable) snapshot. The SELECT then reads
   the snapshot directly. Requires confirming downstream change-tracking
   and read-your-own-writes semantics still hold across the swap.

2. **Snapshot-at-query-start in `MemoryTable.query()`.** When the
   connection is mid-statement-savepoint (or always), capture the
   `pendingTransactionLayer` reference *and* freeze it by materializing
   a snapshot before yielding. Most surgical but doubles snapshot cost
   for every SELECT.

3. **Cursor-stability via BTree path snapshots in `scan-layer.ts`.**
   The underlying btree already supports immutable path-based iteration
   (per `safeIterate`); if the scan captures the tree by reference at
   iteration start and walks a path snapshot, mid-iteration mutations
   would be invisible. This is the most "database-engine" solution and
   most likely to interact correctly with existing change-tracking.

The plan should also explicitly confirm whether other vtab modules
(isolation overlay, store) need parallel fixes — the implement-stage
notes already flag the broader concern that `createTransactionSnapshot`
is memory-module-specific and the halloween risk may be latent in
other backends if they use the same `pending ?? read` pattern.

## Out of scope here

- Don't re-open the eager-vs-lazy choice for `createSavepoint` —
  that change is correct as landed and necessary for the autocommit
  path.
- Don't change the broadcast pattern in `dml-executor.ts`.

## Test to add

A sqllogic block in `test/logic/01.5-insert-select.sqllogic` (or
`test/logic/14-savepoints.sqllogic`) wrapping the canonical
`doubler` case inside `BEGIN ... COMMIT` and seeded by a preceding
`INSERT VALUES` so that `pendingTransactionLayer` is non-null when the
self-ref INSERT runs. Expected result: same row set as the autocommit
case (`(1,10),(2,20),(101,20),(102,40)`).
