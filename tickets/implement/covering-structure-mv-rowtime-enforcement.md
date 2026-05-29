description: Route row-time UNIQUE enforcement through an explicit covering materialized view's backing table — the deferred second half of `covering-structure-unique-enforcement`. The recognition + linkage already shipped (coverage prover, `CoveringStructure` with its reserved `materialized-view` variant, eager constraint↔structure link). The prerequisite (`materialized-view-rowtime-write-through`) has now landed, so an explicit row-time covering MV can become a real row-time enforcement structure: `findIndexForConstraint` returns `{ kind: 'materialized-view', view }` and the conflict check point-looks-up the MV's backing table (reads-own-writes through the coordinated connection), recovering the source PK from the MV projection so REPLACE/IGNORE/ABORT resolve against the correct source row.
files: packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/core/database.ts, packages/quereus-store/src/common/store-table.ts, packages/quereus/src/schema/view.ts, packages/quereus/test/covering-structure.spec.ts, docs/materialized-views.md, docs/lens.md
----

## What this is

The covering-structure arc split into a sound, shippable half (recognition +
linkage, landed by `covering-structure-unique-enforcement`) and this
unsound-until-prerequisite half (enforcement through the recognized structure).
The prerequisite `materialized-view-rowtime-write-through` has landed (a
`row-time` refresh policy keeps the MV's backing table consistent *synchronously*
with each source row-write, within the same transaction, visible mid-statement),
so the soundness gate is closed. This ticket consumes that capability: it makes
the `materialized-view` arm of `CoveringStructure` a live enforcement path.

## Soundness gate (now closed)

Row-time conflict resolution requires the covering structure to be consistent
*at the moment of the write*, before the statement observes its own effects.
`materialized-view-rowtime-write-through` provides exactly this: per source
row-write, the backing table's *pending* transaction layer is maintained through
the same connection a `select` from the MV resolves to (reads-own-writes),
committed/rolled-back in lockstep with the source write
(`MaterializedViewManager.maintainRowTime`, `RowTimeMaintenancePlan` in
`database-materialized-views.ts`). The DML executor drives this *after* each
source row write (`dml-executor.ts maintainRowTimeStructures`); the UNIQUE
conflict check runs *during* the source write, so at check time the backing
table reflects all prior rows of the statement (each maintained after its own
write) but not the row currently being checked — precisely the set we test
against.

## Current state at HEAD

- `CoveringStructure` (manager.ts) already has the
  `{ kind: 'materialized-view'; view }` variant; `findIndexForConstraint` only
  ever returns `memory-index`; `checkSingleUniqueConstraint`'s `materialized-view`
  case `throw`s `StatusCode.UNSUPPORTED` ("not yet implemented").
- The eager link is in place: `linkCoveredUniqueConstraints`
  (`materialized-view-helpers.ts`) stamps `uc.coveringStructureName` (forward
  pointer, source of truth) and `mv.covers` (reverse link) when the coverage
  prover proves an MV covers a UNIQUE constraint. The prover requires the body to
  project **every UC column + the source PK** and to `order by` a permutation of
  the UC columns (so a point lookup answers uniqueness and the conflicting source
  row is reconstructible — `coverage-prover.ts` §§ "Base-table covering").
- The covering MV is enforceable only when it is `row-time`
  (`mv.refreshPolicy.kind === 'row-time'`). A `manual` / `on-commit-incremental`
  covering MV is *not* row-time consistent mid-statement, so it must NOT be used
  for enforcement (fall through to the auto-index, which still exists).
- For physical schemas the auto-index (`ensureUniqueConstraintIndexes`) always
  exists and already enforces, so this path is reachable in v1 only because we
  *prefer* a linked row-time covering MV when one is present (see decision below).
  It becomes the *sole* enforcement structure in the logical-schema/lens world
  (`lens-prover-and-constraint-attachment`, seq 3), where the auto-index is
  retired.

## Design

### Where the lookup lives

The projection knowledge (which backing column carries each source UC column and
each source PK column), the backing-table identity, the partial-WHERE predicate,
and the coordinated-connection plumbing all already live on the
`RowTimeMaintenancePlan` / `MaterializedViewManager`
(`database-materialized-views.ts`): `projectionSourceCols[j]` = source col index
for backing col `j`; `backingPkDefinition`; `getBackingConnection`. So the
backing lookup belongs **on the MV manager**, exposed to the enforcement path via
a thin `Database` shim (mirroring `_maintainRowTimeCoveringStructures` /
`_hasRowTimeCoveringStructures`). The source-table managers (memory + store) only
*resolve* the conflicting source PK(s) and then apply IGNORE/ABORT/REPLACE
against their own storage exactly as the index path does.

Two new internal Database/manager surfaces (names indicative):

- `db._findRowTimeCoveringStructure(schemaName, tableName, uc)
   : MaterializedViewSchema | undefined`
  — returns the linked, `row-time`, non-stale, non-diverged covering MV for this
  constraint if one exists. Resolution: `uc.coveringStructureName` is the MV name
  (source of truth); confirm via the MV manager that a `row-time` plan exists for
  this source (`rowTimeBySource` keyed by lowercased `schema.table`) and that the
  plan's MV `covers` this constraint. Cheap; called from `findIndexForConstraint`.

- `db._lookupCoveringConflicts(mv, uc, newRow, newSourcePk)
   : Promise<Array<{ pk: SqlValue[]; row?: Row }>>`
  — reads the covering MV's backing table for rows whose backing columns equal
  `newRow`'s UC values, recovers each source PK from the projected PK columns,
  and excludes the row whose recovered source PK equals `newSourcePk` (the row
  being written). Returns the conflicting source PK(s). Reads-own-writes: the
  read must resolve to the **coordinated backing connection's pending layer** when
  one exists this transaction (the same connection `maintainRowTime` writes), else
  the committed base. **Recommended v1 implementation:** issue a parameterized
  point-lookup against the backing table *through the db* (a `select <pk-cols>
  from <backing> where <uc-cols> = ?...`); the normal query path resolves the
  backing table to its coordinated connection automatically (this is the whole
  point of the row-time design — see `database-materialized-views.ts`
  §3 and `registerMaterializedView`'s `sourceScope` substitution), giving
  reads-own-writes and module-agnosticism for free. This also satisfies the
  store-path parity requirement with no second implementation, because the
  backing table is always the `memory` module in v1 regardless of the source
  module. A direct backing-btree prefix scan (the backing PK leads with the UC
  ordering columns) is a sound later optimization, not v1.

### findIndexForConstraint decision (preference)

When `db._findRowTimeCoveringStructure(...)` returns an MV, `findIndexForConstraint`
returns `{ kind: 'materialized-view', view }` **in preference to** the
`memory-index` variant. Rationale: it makes the MV path the live, testable
enforcement path in v1 (physical schemas otherwise never reach it, since the
auto-index always exists), and it is exactly the behavior the lens future
requires once the auto-index is retired. Document the tradeoff in
`docs/materialized-views.md`: with a linked row-time covering MV present, the
covering MV — not the auto-index — answers conflict resolution; the auto-index
remains maintained but unconsulted (a redundant read-answering copy).

NULL-skip and partial-UNIQUE predicate gating happen *before* the covering switch
(already do for `newRowData`); keep that ordering. The MV's own partial-WHERE
(when the body has a `Filter`) governs which backing rows exist, so the lookup
inherits partial scoping naturally — but the source-side NULL/predicate skip must
still short-circuit identically to the index path so a not-in-scope source row is
never checked.

### Conflict resolution + eviction maintenance (the sharp edge)

`checkSingleUniqueConstraint`'s `materialized-view` case (memory) and
`store-table.ts`'s `checkUniqueConstraints` (store) call
`_lookupCoveringConflicts`, then for each conflict:

- **IGNORE** → return `{ status: 'ok', row: undefined }`.
- **ABORT/FAIL/ROLLBACK** → return the `constraint` `UpdateResult` with the
  conflicting source row (recover it from the source layer/store via the
  conflict PK, as the index path does with `lookupEffectiveRow`).
- **REPLACE** → evict the conflicting **source** row (`recordDelete` on the
  source transaction layer / store `deleteRowAt`), then continue the insert.

**Critical:** a conflict-resolution eviction is performed directly on source
storage and therefore bypasses the DML-executor row-time maintenance hook
(`maintainRowTimeStructures` only fires for DML-executor row writes, not for
evictions internal to a vtab's `xUpdate`). The evicted source row's backing row
(keyed on the same UC values but the *evicted* source PK, distinct from the new
row's backing key) would otherwise go **stale within the same statement** and
produce phantom conflicts for a later same-UC row. So every REPLACE eviction on
this path must also drive backing maintenance for the delete —
`db._maintainRowTimeCoveringStructures(sourceBase, { op: 'delete', oldRow:
conflictRow })` — before continuing. Verify the auto-index/PK-conflict REPLACE
paths that also `recordDelete` are not double-maintaining (they already trigger
maintenance via the DML executor only for the *outer* statement row, not internal
evictions — confirm and keep consistent).

### Async ripple

The lookup is async (a backing query). `checkUniqueConstraints` /
`checkSingleUniqueConstraint` (memory) become `async`; `performInsert` and
`performUpdate` already `await` into the chain, but `performUpdateWithPrimaryKeyChange`
is currently sync — make it `async` and `await` it from `performUpdate`
(`manager.ts:787`). The store path is already async. Keep the fast path cheap:
short-circuit `_findRowTimeCoveringStructure` to `undefined` with a single
synchronous map lookup when the source table has no row-time covering MV (reuse
the `rowTimeBySource` index the maintenance hot path already consults via
`_hasRowTimeCoveringStructures`), so non-covered tables pay effectively nothing
and stay on the synchronous index path.

## Expected behavior / key tests (extend `test/covering-structure.spec.ts`)

Build a real row-time covering MV and drive conflicts through it
(`create materialized view ix as select x, y, id from t order by x, y
 with refresh = 'row-time'` over `t(id integer primary key, x, y, unique(x,y))`):

- **INSERT conflict, default ABORT** → `UNIQUE constraint failed: t (x, y)`; the
  reported `existingRow` is the prior source row recovered via the MV projection.
- **INSERT OR IGNORE** → duplicate silently skipped; row count unchanged.
- **INSERT OR REPLACE** → prior source row evicted (correct source PK recovered
  from the projection), new row present; **and** the evicted row's backing entry
  is gone (assert a second same-(x,y) insert in the same statement/txn does not
  see a phantom). This is the regression test for the eviction-maintenance edge.
- **Multi-row INSERT with an intra-statement duplicate** → second row conflicts
  with the first (reads-own-writes through the coordinated backing connection
  mid-statement), resolving per the OR clause.
- **UPDATE that moves a row onto an existing UC value** (no PK change and PK
  change variants) → conflict detected via the MV; REPLACE evicts + maintains.
- **Partial covering MV** (`... where active = 1 order by x, y`): a source row
  outside the predicate is not checked; two in-scope rows with the same (x, y)
  conflict; an in-scope vs out-of-scope pair does not.
- **Non-row-time covering MV is NOT used for enforcement**: the same covering
  body with `refresh = 'manual'` (or `on-commit-incremental`) must fall through
  to the auto-index — `findIndexForConstraint` returns `memory-index`, and the
  `materialized-view` arm is never hit. (Guards against using a mid-statement-
  inconsistent backing table.)
- **Store-path parity** (`packages/quereus-store/src/common/store-table.ts`):
  the same conflict scenarios pass against the store module (the backing table is
  `memory`, queried through the db) — add/extend a store-path test or confirm the
  existing store logic-test sweep covers it. Note: full `yarn test:store` is
  slow; run the targeted spec under store config if feasible, else document the
  deferral to CI.

Keep all existing recognition/linkage tests green (the eager prove-and-link and
shape-rejection cases must be untouched).

## Out of scope

- Building the row-time write-through maintenance itself (landed —
  `materialized-view-rowtime-write-through`).
- FD-driven and multi-source coverage recognition
  (`coverage-prover-fd-driven-coverage`, `coverage-prover-multi-source-bodies`).
- Retiring the auto-index in the logical-schema world
  (`lens-prover-and-constraint-attachment`, seq 3) — this ticket only makes the
  MV-backed enforcement path *exist and be correct*; the lens ticket makes it the
  *sole* structure.
- The direct backing-btree prefix-scan optimization (v1 uses a db query).

## TODO

### Phase 1 — backing lookup on the MV manager
- Add `MaterializedViewManager` method (e.g. `lookupCoveringConflicts(mv, uc,
  newRow, newSourcePk): Promise<Array<{ pk: SqlValue[]; row?: Row }>>`) that
  maps source UC/PK columns → backing columns via the MV's `RowTimeMaintenancePlan`
  (`projectionSourceCols` inverse + `backingPkDefinition`), point-looks-up the
  backing table through the db (reads-own-writes via the coordinated connection),
  recovers source PKs from the projected PK columns, and excludes `newSourcePk`.
- Add a resolver (`findRowTimeCoveringStructure(schemaName, tableName, uc)`) that
  returns the linked, `row-time`, non-stale, non-diverged covering MV or
  `undefined`, with an O(1) negative fast path off `rowTimeBySource`.
- Expose both via thin `Database` shims (`_findRowTimeCoveringStructure`,
  `_lookupCoveringConflicts`) next to the existing
  `_maintainRowTimeCoveringStructures` / `_hasRowTimeCoveringStructures`
  (`database.ts:~1745`).

### Phase 2 — memory enforcement path
- `findIndexForConstraint` (manager.ts:~969): when
  `db._findRowTimeCoveringStructure(this.schemaName, this._tableName, uc)` returns
  an MV, return `{ kind: 'materialized-view', view }` in preference to
  `memory-index`; else unchanged.
- Replace the `materialized-view` `throw` in `checkSingleUniqueConstraint`
  (manager.ts:~941) with `await this.checkUniqueViaMaterializedView(...)`.
- Implement `checkUniqueViaMaterializedView`: call `_lookupCoveringConflicts`;
  resolve IGNORE/ABORT/REPLACE against the source layer (mirror
  `checkUniqueViaIndex` — `lookupEffectiveRow`, `recordDelete`); on REPLACE
  eviction, drive `db._maintainRowTimeCoveringStructures(sourceBase, { op:
  'delete', oldRow })` so the evicted backing row is removed mid-statement.
- Make `checkUniqueConstraints`, `checkSingleUniqueConstraint`,
  `performUpdateWithPrimaryKeyChange` async; `await` at call sites
  (manager.ts:739, 787, 791, 834).

### Phase 3 — store enforcement parity
- In `store-table.ts checkUniqueConstraints` (~line 1004): before/instead of the
  per-scan `findUniqueConflict`, when `db._findRowTimeCoveringStructure(...)`
  returns an MV, resolve conflicts via `_lookupCoveringConflicts` and apply
  IGNORE/ABORT/REPLACE (REPLACE via `deleteRowAt` + the same backing-maintenance
  call). Reuse, don't fork: a single shared resolution helper if the shapes align.

### Phase 4 — tests + docs
- Extend `test/covering-structure.spec.ts` with the enforcement cases above
  (ABORT/IGNORE/REPLACE, intra-statement dup, UPDATE move, partial, non-row-time
  fall-through, eviction-staleness regression).
- Update `docs/materialized-views.md` § Covering structures: flip the soundness
  note from "deferred" to "enforced via row-time write-through"; document the
  preference of a linked row-time covering MV over the auto-index and the
  eviction-maintenance requirement.
- Update `docs/lens.md` § Constraint Attachment: note the row-time covering MV is
  now a conflict-resolution-capable enforcement structure (the obligation that
  `lens-prover-and-constraint-attachment` depends on is satisfiable).
- Run `yarn workspace @quereus/quereus test` (stream output) + lint; fix anything
  in-diff. If a store-specific failure surfaces unrelated to this diff, follow the
  pre-existing-error protocol rather than chasing it.
