description: Row-time (write-through) materialized-view maintenance for the covering-index shape — a new `row-time` refresh policy that keeps a covering MV's backing table consistent synchronously with each source row-write (within the same transaction, visible mid-statement), not at COMMIT. Delivers the *maintenance capability* only; routing row-time UNIQUE enforcement through the MV's backing table is the separate downstream ticket `covering-structure-mv-rowtime-enforcement` (which lists this as its prereq).
prereq:
files: packages/quereus/src/schema/view.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/core/database.ts, packages/quereus/src/core/database-transaction.ts, packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/vtab/memory/layer/connection.ts, packages/quereus/src/planner/analysis/coverage-prover.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/test/logic/52-materialized-views-incremental.sqllogic, docs/materialized-views.md, docs/incremental-maintenance.md, docs/lens.md
----

## Resolved design fork (the plan ticket's open question)

The plan ticket asked: *is row-time write-through a distinct policy, or is the
covering-index shape special-cased (maintained like a secondary index) while
general MVs stay commit-time?*

**Decision: a distinct `row-time` refresh policy, gated to the covering-index
shape.** This is the pragmatic first delivery the plan ticket favored — it is
effectively *"a user-declared, synchronously-maintained materialized index,"*
which is exactly what row-time UNIQUE enforcement needs. General MV bodies
(joins, aggregates, recursive CTE, set ops) are **rejected** for `row-time` at
create with a diagnostic pointing at `on-commit-incremental` / `manual`; the
general-body row-time case is parked in
`backlog/materialized-view-rowtime-general-bodies.md`.

Rationale for restricting to the covering-index shape:

- The shape (single source `T`, linear `TableReference → optional Filter →
  Project → optional Sort`, projecting **every** `T` PK column) makes each source
  row map to **exactly one** backing row. Maintenance is then a **pure
  projection of the changed row** — no body re-execution, no scan: delete the old
  image's backing key, upsert the new image's backing row. That is O(log n) per
  row (a btree delete + insert), identical in cost to the secondary-index
  maintenance the UNIQUE auto-index already performs. This bounded per-row cost is
  the whole reason row-time is affordable for this shape and not for general
  bodies.
- It is precisely the shape the **coverage prover**
  (`planner/analysis/coverage-prover.ts`) already recognizes as covering a UNIQUE
  constraint (`covering-structure-unique-enforcement`), so eligibility and the
  projection plan can be derived from the same plan-walk.

### Considered and rejected

- **General-body row-time policy** (recompute the body per source write):
  unbounded per-row cost for joins/aggregates/recursion; no use case needs it yet.
  Parked in backlog.
- **Collapse the covering MV back into a hidden secondary index on the source
  manager** (transactionally trivial — same layer as the source row). Rejected:
  it defeats the lens design intent that *"indexes are basis-layer materialized
  views"* (an addressable, ordered, read-serving relation), and breaks the
  abstraction `covering-structure-mv-rowtime-enforcement` is written against
  (`findIndexForConstraint` returns `{ kind: 'materialized-view', view }` and
  point-looks-up *the MV's backing table*). We keep the MV a first-class
  addressable relation, but **reuse the projection/predicate logic** secondary
  indexes use for the per-row maintenance.

## Architecture

### Policy spectrum

`RefreshPolicy` (`schema/view.ts`) gains a third point:

```
manual  →  on-commit-incremental  →  row-time
(refresh)   (post-commit delta)      (synchronous write-through)
```

```ts
export type RefreshPolicy =
  | { kind: 'manual' }
  | { kind: 'on-commit-incremental' }
  | { kind: 'row-time' };               // new
```

Parsed from `with refresh = 'row-time'` (the existing `with refresh = '...'`
clause; add the literal to the parser/validator and to `ast-stringify` so DDL
round-trips). `manual` stays the default.

### Eligibility (checked at create, rolls the MV back on failure)

`row-time` is accepted **only** for the covering-index shape:

- a **single** source table `T` with a primary key;
- a row-preserving linear body `TableReference → optional Filter → Project →
  optional Sort` (no aggregate, join, `DISTINCT`, set op, recursive CTE,
  `LIMIT`/`OFFSET`, TVF fan-out);
- the projection includes **every** PK column of `T` (so the backing row carries a
  deterministic identity derived from the source row);
- a partial `where` predicate, if present, must be evaluable on a single source
  row (no subqueries / cross-row references).

This is a strict **superset** of the on-commit-incremental row-preserving gate
plus the coverage-prover shape. Reuse the prover's shape-walk
(`coverage-prover.ts`) and `compile()`'s existing row-preserving classification
in `database-materialized-views.ts` rather than re-deriving. Anything else →
reject with a diagnostic naming the offending shape and suggesting
`on-commit-incremental` or `manual`.

### Per-row maintenance plan (built at registration)

For an eligible MV, build and cache a plan keyed by the source base:

```ts
interface RowTimeMaintenancePlan {
  sourceBase: string;                         // lowercased schema.table of T
  backingSchema: string;
  backingTableName: string;                   // sqlite_mv_<name>
  /** Project a source row → the backing row, in backing column order. */
  projectBackingRow(sourceRow: Row): Row;
  /** Backing physical PK from a source row (for deleting the old image). */
  backingKeyFromSourceRow(sourceRow: Row): BTreeKeyForPrimary;
  /** Partial-UNIQUE-style predicate; a source row contributes a backing row
   *  only when this is unambiguously TRUE. Absent ⇒ always in scope. */
  predicate?: CompiledPredicate;
}
```

Projection and `backingKeyFromSourceRow` are derived from attribute provenance
exactly as `computeDeleteKeyOrder` does today (passthrough column ids forward
directly). `predicate` compiles the body's `where` with `compilePredicate`
(already used by the partial-UNIQUE scan path in `manager.ts`).

Per source row-write the hook emits, against the backing table's transactional
connection:

| source op | maintenance |
|---|---|
| insert `r` | if `predicate(r)` → upsert `projectBackingRow(r)` |
| delete `r` | if `predicate(r)` (was in scope) → delete `backingKeyFromSourceRow(r)` |
| update `old→new` | delete old image if in scope; upsert new image if in scope (covers predicate-scope transitions and key-changing updates) |

No scan, no body run — the changed row alone determines the backing delta.

### Synchronous, transactional integration (the load-bearing part)

The maintenance must be **(a) synchronous** (applied as part of the writing
statement, before it observes its own effects), **(b) transactional** (on a layer
that commits/rolls-back in lockstep with the source write), and **(c)
reads-own-writes** (visible to later reads/conflict-checks in the same
transaction).

**Seam: the runtime DML write boundary** — `runtime/emit/dml-executor.ts`, the
same per-row site that already calls `ctx.db._recordInsert/_recordUpdate/
_recordDelete` to feed the change log (lines ~427–676). After each source row is
written and recorded, synchronously drive `db._maintainRowTimeCoveringStructures(
sourceBase, { op, oldRow, newRow })` for any registered row-time plan on
`sourceBase`. This seam is **module-agnostic** (memory today, store later — see
`covering-structure-mv-rowtime-enforcement`'s store-parity note) and runs per row
in statement order, which is what reads-own-writes within a multi-row statement
requires.

**Backing write target: the backing table's ordinary transactional connection.**
Route the maintenance write through the *same* `MemoryTableConnection` a
`select from sqlite_mv_<name>` in this transaction would use, so:

- the backing pending `TransactionLayer` is part of the Database's active
  connection set and therefore committed atomically by the existing **coordinated
  commit** (`database-transaction.ts` → `inCoordinatedCommit`, sibling layers) and
  discarded by the existing rollback broadcast; and
- a read of the MV later in the same transaction sees the pending writes **for
  free** (reads-own-writes) — no separate overlay needed (this is the row-time
  analogue of, and replacement for, the on-commit `pendingDelta` overlay).

The backing table is read-only to user DML (`assertNotMaterializedView` at build
time; backing manager `isReadOnly`), so add a **privileged transactional
maintenance write** on `MemoryTableManager` — the transaction-layer analogue of
the existing committed-base `applyMaintenance`: apply an ordered
`MaintenanceOp[]` (`delete-key` / `upsert`) to a *connection's pending
`TransactionLayer`* (not the committed base), bypassing `validateMutationPermissions`.
It reuses `recordUpsert` / `recordDelete` on the layer so secondary-index and
change-tracking bookkeeping stay correct.

**Autocommit wrinkle (verify carefully).** A source write outside an explicit
`BEGIN` autocommits. `MemoryTableManager.performMutation`'s per-manager autocommit
only commits the *source* connection — it does not know about the backing
connection. The maintenance + backing commit must ride the **statement-level**
autocommit boundary so both connections commit together. Driving maintenance from
the runtime DML boundary (above the per-manager autocommit) is the recommended way
to inherit statement-level atomicity; confirm during implement that a bare
autocommit `insert into T` both maintains the backing table and commits it
atomically (no orphaned/uncommitted backing pending layer), and that a failed
source write leaves no backing delta.

### What this ticket does NOT do

- **No enforcement routing.** `findIndexForConstraint` still never returns the
  `materialized-view` variant; `checkSingleUniqueConstraint`'s `materialized-view`
  arm still throws `UNSUPPORTED`. Consuming the now-row-time backing table for
  conflict resolution is `covering-structure-mv-rowtime-enforcement` (prereq =
  this ticket). This keeps the deliverable independently testable via direct MV
  reads (below) without depending on the enforcement half.
- **No general-body row-time** (backlog).
- **No store-module path** (the runtime seam is module-agnostic, but the
  privileged transactional maintenance write is implemented for the memory module
  here; store parity rides the enforcement ticket).

## Key tests (TDD targets)

Add to `test/logic/52-materialized-views-incremental.sqllogic` (or a sibling
`53-materialized-views-rowtime.sqllogic`) — these are observable **without**
enforcement, by reading the MV name (which resolves to the backing table) inside
a transaction:

- **Mid-statement / mid-transaction visibility.** `create materialized view ix_t
  as select x, id from t order by x with refresh = 'row-time'`. In an explicit
  transaction: `insert into t ...`; then `select * from ix_t` **before** commit →
  reflects the just-inserted row. (Contrast: an `on-commit-incremental` MV would
  *not* reflect it pre-commit — a good differential assertion.)
- **Rollback reverts.** `begin; insert into t ...; <ix_t reflects it>; rollback;`
  → `ix_t` returns to the pre-transaction contents (backing pending layer
  discarded with the source write).
- **Update / scope transitions.** Update a row's projected column → old backing
  row gone, new present. For a partial body (`where x > 0`): an update moving a
  row out of scope deletes its backing row; moving in adds it.
- **Self-collision within one multi-row statement** (reads-own-writes): a
  multi-row `insert into t` whose rows project to the same backing key — the
  second row's maintenance sees the first's pending backing write. (Becomes a
  hard conflict only once enforcement lands; here assert the backing contents are
  the set, not a duplicate-PK crash.)
- **Eligibility rejections** (create-time): aggregate body, join body, `distinct`,
  `limit`, set op, recursive CTE, projection dropping a source PK column, and a
  source without a PK each error with the row-time diagnostic. A `manual` MV over
  the same body still succeeds.
- **Cost.** No per-row body execution: a residual scheduler is *not* built for
  `row-time` MVs (assert via the existing instruction-tracer / metrics seam, or at
  least that no plan is compiled per row).

## TODO

### Phase 1 — policy + eligibility
- Add `{ kind: 'row-time' }` to `RefreshPolicy` (`schema/view.ts`); parse `with
  refresh = 'row-time'`; round-trip in `ast-stringify.ts`.
- In `database-materialized-views.ts` `registerMaterializedView`, branch
  `row-time` to a new eligibility check reusing the coverage-prover shape-walk +
  `compile()`'s row-preserving classification. Reject non-covering-index shapes
  with a clear diagnostic (roll the MV back on throw, like the incremental gate).

### Phase 2 — per-row maintenance plan
- Build and cache `RowTimeMaintenancePlan` per eligible MV (projection +
  `backingKeyFromSourceRow` via attribute provenance, reusing
  `computeDeleteKeyOrder`'s provenance logic; `predicate` via `compilePredicate`).
- Index plans by source base on the `MaterializedViewManager` for O(1) lookup at
  write time; invalidate on schema-change / drop / re-register (mirror
  `releaseEntry`).

### Phase 3 — privileged transactional maintenance write (memory module)
- Add a `MemoryTableManager` method that applies an ordered `MaintenanceOp[]`
  (`delete-key` / `upsert`) to a given **connection's pending `TransactionLayer`**
  (the transaction-layer analogue of `applyMaintenance`), bypassing
  `validateMutationPermissions`, via `recordUpsert`/`recordDelete`.
- Add a `Database` helper to obtain (lazily create) the backing table's
  connection for the **current transaction** and ensure it is in the active
  connection set so coordinated commit/rollback covers it.

### Phase 4 — synchronous hook at the DML write boundary
- Add `Database._maintainRowTimeCoveringStructures(sourceBase, change)`: look up
  plans, compute the per-row backing delta, apply it through the coordinated
  backing connection.
- Call it from `runtime/emit/dml-executor.ts` immediately after each
  `_recordInsert/_recordUpdate/_recordDelete`, per row, for sources with a
  registered plan (no-op fast path when none).
- Resolve the **autocommit wrinkle**: verify autocommit writes maintain + commit
  the backing atomically; failed source write ⇒ no backing delta.

### Phase 5 — docs + validation
- `docs/materialized-views.md`: add `row-time` to the policy spectrum, the
  Eligibility section, and update the § Covering structures soundness note (the
  write-through prerequisite now *exists* for the covering-index shape; enforcement
  routing remains the downstream ticket).
- `docs/incremental-maintenance.md`: note row-time as a synchronous, in-transaction
  variant driven from the DML boundary (vs the post-commit DeltaExecutor consumers)
  and that it does **not** use a `pendingDelta`-style overlay (reads-own-writes is
  native to the shared transaction layer).
- `docs/lens.md` § Constraint Attachment / "covering MV → row-time": note the
  capability now exists for the covering-index shape (enforcement still pending its
  own ticket).
- `yarn build` clean; `yarn lint` (quereus) clean; `yarn test` green with the new
  tests. Stream long runs with `Tee-Object` per AGENTS.md. (Skip `yarn test:store`
  — store path is out of scope here.)
