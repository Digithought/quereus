description: Materialized views — engine substrate (phase 1, manual refresh). Parser/AST for `create materialized view` / `refresh materialized view` / `drop materialized view`; `MaterializedViewSchema` sibling + catalog registration with dual TableSchema bridging; MemoryTable-backed storage with initial materialization and atomic base-layer swap on refresh; query resolution to the backing table; read-only write boundary; schema-change staleness invalidation. Excludes declarative-schema round-trip + docs (sibling `materialized-view-declarative-docs`).
prereq:
files: packages/quereus/src/parser/ast.ts, packages/quereus/src/parser/parser.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/src/schema/view.ts, packages/quereus/src/schema/schema.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/schema/catalog.ts, packages/quereus/src/schema/change-events.ts, packages/quereus/src/schema/table.ts, packages/quereus/src/planner/building/block.ts, packages/quereus/src/planner/building/create-view.ts, packages/quereus/src/planner/building/select.ts, packages/quereus/src/planner/nodes/create-view-node.ts, packages/quereus/src/runtime/emit/create-view.ts, packages/quereus/src/runtime/emit/create-table.ts, packages/quereus/src/vtab/memory/module.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/vtab/memory/layer/base.ts, packages/quereus/src/core/database.ts, packages/quereus/src/core/database-assertions.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/analysis/change-scope.ts
----

## Scope

Land the **substrate** for materialized views as "keyed derived relations": stored relations defined by a query body, primary-keyed, addressable like any virtual table. Phase 1 is **manual full-refresh**. Incremental refresh, `concurrently`, and covering-structure enforcement are siblings tracked separately. Declarative-schema round-trip, the schema-differ/hasher `bodyHash` integration, and the new `docs/materialized-views.md` are split into the sibling implement ticket `materialized-view-declarative-docs` (which prereqs this one) — **do not do them here**, but DO populate the `bodyHash` field on the schema (this ticket owns the schema shape).

This is the read-cache MV concern, framed deliberately narrow so the lens layer and covering ticket build on top without churning the substrate.

## Verified codebase anchors (from plan research — trust these paths)

- **`ViewSchema`** lives at `schema/view.ts:8-27`: `{ name, schemaName, sql, selectAst: AST.QueryExpr, columns?, tags? }`. `MaterializedViewSchema` is a **sibling** here (do not extend).
- **Views are dual-registered**: `Schema` (`schema/schema.ts:15`) keeps `tables: Map` and a separate `views: Map`. `addTable`/`getTable` (`:37`,`:47`), `addView`/`getView` (`:92`,`:109`), `getAllViews` (`:118`). The two maps enforce name-disjointness. `TableSchema.isView` (`schema/table.ts:52`) is the bridge flag. `PrimaryKeyColumnDefinition` = `{ index: number; desc?: boolean; collation?: string }` (`schema/table.ts:450`).
- **AST**: `CreateViewStmt` is `type: 'createView'` (`parser/ast.ts:314-323`) with `select: QueryExpr`. `DropStmt` discriminates on **`objectType: 'table'|'view'|'index'|'trigger'|'assertion'`** (`parser/ast.ts:333-338`) — *not* a `kind` field. `QueryExpr` union at `parser/ast.ts:273-278`.
- **Parser**: `createStatement()` dispatch at `parser/parser.ts:2257`; `createViewStatement()` at `:2462` (uses `this.parseQueryExpr(withClause, /*requireReturning*/ true)`); `dropStatement()` at `:2539`. Contextual-keyword constant `CONTEXTUAL_KEYWORDS` at `parser/parser.ts:45` (the recent `parser-contextual-keywords-constant` mechanism). `MATERIALIZED` is already consumed in CTE parsing via `consumeKeyword('MATERIALIZED', ...)` (`:313`).
- **Statement→build dispatch**: `planner/building/block.ts:28-58` switch on `stmt.type` (`case 'createView'`, `case 'drop'` sub-switching on `objectType`). Imports from `./create-view.js`, `./drop-view.js`.
- **View build flow**: `planViewBody()` (`building/create-view.ts:17-42`) accepts `select`/`values`, rejects DML bodies; `buildCreateViewStmt()` (`:47-83`) validates arity & reconstructs SQL via `createViewToString`. `CreateViewNode` at `nodes/create-view-node.ts:11-46`. Create emit at `runtime/emit/create-view.ts:8-56` (calls `schema.addView`).
- **Resolution branch (the one-line decision point)**: `building/select.ts:385-441`. Today: `getView(...)` → `if (viewSchema)` recursively expands the body inline; `else` → `buildTableReference()`. MV reference must take the **table-reference** path against the backing table.
- **Backing-table creation**: `create table` emit (`runtime/emit/create-table.ts`) just calls `schemaManager.createTable(stmt)`. `SchemaManager.createTable` (`schema/manager.ts:1459`) calls `module.create(db, baseTableSchema)` (`:1507`), `finalizeCreatedTableSchema`, `schema.addTable`, then `changeNotifier.notifyChange({ type: 'table_added', ... })`. **Reuse this path** by synthesizing a backing-table definition rather than hand-rolling `module.create`.
- **MemoryTable internals**: `BaseLayer` ctor `vtab/memory/layer/base.ts:16`. `MemoryTableManager` holds `baseLayer` + `_currentCommittedLayer` (`vtab/memory/layer/manager.ts:67`). Atomic-commit swap pattern: `_currentCommittedLayer = pendingLayer` under a latch (`:340`, latch acquired `:300`; schema-change latch `MemoryTable.SchemaChange:<schema>.<table>` at `:995`). Direct base-layer mutation helpers exist: `insertRow(row)` (`:980`) and `scanAllRows(): Row[]` (`:967`). **No single "swap base layer" method exists yet — add one** (build a fresh `BaseLayer`, fill via the rebuild path, swap `_currentCommittedLayer`/`baseLayer` under the SchemaChange latch).
- **Key inference**: `keysOf(rel): readonly (readonly number[])[]` at `planner/util/fd-utils.ts:763-794` — returns **arrays of column indices only (no `desc`)**, with an all-columns fallback for sets. `TableReferenceNode.computePhysical` (`nodes/reference.ts:106-210`) exposes keys/FDs/ordering for free once the backing ref is in the plan.
- **Change-scope**: `Statement.getChangeScope()` (`core/statement.ts:609`) → `analyzeChangeScope` (`planner/analysis/change-scope.ts:203-246`), which walks the plan via `collectTableRefs`. Because MV refs resolve to the backing `TableReferenceNode`, change-scope reports the backing table **automatically** — verify with a test, no new code expected.
- **Schema-change events**: union `SchemaChangeEvent` at `schema/change-events.ts:65-78` (`table_added`/`table_removed`/`table_modified`, plus function/assertion/module/collation variants); `SchemaChangeNotifier.addListener` (`:88-142`). `AssertionEvaluator.subscribeToSchemaChanges()` (`core/database-assertions.ts:140-148`) is the exact pattern to mirror; managers are instantiated in `Database` ctor around `core/database.ts:134-136`; cleanup pattern in `dispose()` (`database-assertions.ts:161`).
- **Hash primitive** (used in the sibling ticket, but populate the field here): `fnv1aHash` + `toBase64Url` from `util/hash.ts`.

## Syntax

```sql
create materialized view mv_name as <query-expr>;
refresh materialized view mv_name;
drop materialized view mv_name;
```

`<query-expr>` is a `QueryExpr` (`select`/`values`/compound). DML bodies are rejected — reuse `planViewBody`'s rejection so the diagnostic matches `create view`.

`order by` in the body is allowed and significant: it describes the clustered/ordered layout of the backing structure (the "materialized index" the covering ticket lights up). Retain the body's ordering; v1 stores it but only uses it to seed backing-table ordering — UNIQUE enforcement is out of scope.

Backing-module pluggability (`create materialized view ... using mod(...)`) is **parsable-but-restricted-to `mem()`** in v1: the AST carries the optional module slot so the future choice is additive; reject anything but `memory` at build time with a clear "only mem() backing supported in v1" diagnostic.

## `MaterializedViewSchema`

Add to `schema/view.ts` as a sibling of `ViewSchema`:

```ts
interface MaterializedViewSchema {
  name: string;
  schemaName: string;
  sql: string;                 // original DDL text (round-trippable)
  selectAst: AST.QueryExpr;    // body
  columns?: ReadonlyArray<string>;
  tags?: Readonly<Record<string, SqlValue>>;

  /** Backing-table identity. Same schemaName; conventional derived name. */
  backingTableName: string;

  /** Inferred PK of the view output, derived from keysOf on the optimized body.
   *  NOTE: keysOf returns column-index arrays WITHOUT direction; desc defaults
   *  false. When keysOf yields no usable key, fall back to the all-columns key
   *  (Quereus default). Such an MV is incremental-ineligible until Phase 2. */
  primaryKey: ReadonlyArray<{ index: number; desc: boolean }>;

  /** fnv1aHash(toBase64Url(...)) of the optimized body's structural shape.
   *  Consumed by the declarative-schema differ (sibling ticket) to detect
   *  "body changed → rebuild". Populate it here even though the differ wiring
   *  lands next ticket. */
  bodyHash: string;

  /** Body ordering captured from `order by` (for the materialized-index path).
   *  v1 stores; covering ticket consumes. */
  ordering?: ReadonlyArray<{ index: number; desc: boolean }>;

  /** Staleness flag set by the schema-change subscription when a source table
   *  is modified/removed in a way that may break the body. */
  stale?: boolean;
}
```

The MV is **dual-registered**: the backing table is a normal `TableSchema` in the `tables` map (created via `schemaManager.createTable`), and the `MaterializedViewSchema` goes in a new `materializedViews: Map` on `Schema` (sibling of `views`). Name-disjointness must extend to the new map (an MV name collides with tables AND views). Add `addMaterializedView`/`getMaterializedView`/`getAllMaterializedViews`/`removeMaterializedView` to `Schema` and the corresponding pass-throughs on `SchemaManager` (mirror the view methods at `manager.ts:461` / `:675`). The backing table uses a conventional derived name (e.g. `sqlite_mv_<mvname>` or `<mvname>$mv` — pick one, keep it reserved/hidden from catalog enumeration the way internal tables are; see `catalog.ts:79-94` for the `isView` filter pattern to exclude backing tables from user-facing catalog listings).

## Backing-table generation (create)

On `create materialized view`:

1. Build + optimize the body (reuse `planViewBody` for validation/arity; then run it through the optimizer to get the physical output relation).
2. Derive PK from `keysOf` on the optimized output. Map the first usable key's column indices to `{ index, desc: false }`; if none, fall back to all-columns. Capture body ordering from `order by` if present.
3. Synthesize a backing-table definition (columns from the body's output attributes; PK from step 2; module `memory`) and create it via `schemaManager.createTable(...)` so the existing `module.create` + `finalizeCreatedTableSchema` + `addTable` + `table_added` notify all fire. (If a synthesized `CreateTableStmt` AST is awkward, add a thin `SchemaManager.createBackingTable(def)` that reuses the same internal sequence — do NOT bypass `module.create`.)
4. Run the body to completion and bulk-insert results into the backing table's base layer (via the manager's direct-insert path, `insertRow`). Failures roll back the `create` (drop the backing table, do not register the MV).
5. Register the `MaterializedViewSchema`; emit a `materialized_view_added` event.

## Query resolution

In `building/select.ts:385-441`, before/after the `getView` check, look up `getMaterializedView(schemaName, name)`. On hit, emit a **`TableReferenceNode` to the backing table** (the same `buildTableReference` path the `else` branch uses), NOT a body expansion. Effects (all free): optimizer sees the backing table's physical-property surface; `getChangeScope()` reports the backing table; the body AST stays on the schema for the sibling ticket's declarative emission and the body-hash check.

## Mutation semantics: read-only (v1)

`insert into mv` / `update mv set ...` / `delete from mv` are **rejected** with: *"materialized views are read-only; write to the source tables instead."* Implement this where DML targets are resolved (the write-path table resolution; find where `insert`/`update`/`delete` resolve their target table name and reject if it names a `MaterializedViewSchema`). Source tables remain writable normally; MV reads see new source state only after `refresh`. Rationale: write-through requires the (unshipped) view-updateability pass; gated follow-up `materialized-view-writes-through-body` (backlog) — file when view-updateability lands. Body AST is retained, so enabling write-through later is a routing-only change.

## Refresh execution

`refresh materialized view mv_name`:

1. If MV is `stale`, re-validate the body against current source schemas first; on validation failure, error with the staleness diagnostic (below) and abort.
2. Acquire the backing table's `MemoryTable.SchemaChange:<schema>.<table>` latch.
3. Re-run the body to completion into a fresh `BaseLayer` (build a new base, fill via the rebuild/`insertRow` path).
4. Atomically swap the manager's `baseLayer`/`_currentCommittedLayer` to the new base. **Add a `MemoryTableManager.replaceBaseLayer(rows | newBase)` primitive** — the swap pattern already exists in `commitTransaction` (`manager.ts:340`); factor it so refresh reuses it under the SchemaChange latch.
5. Emit `materialized_view_refreshed`.

Concurrent reads during refresh are **not supported** (no `concurrently`): a reader blocks on the latch, consistent with `alter table`. Readers must see either fully-old or fully-new state — never half-state.

## Schema-change invalidation

Add a small `MaterializedViewManager` (mirror `AssertionEvaluator`, `core/database-assertions.ts:140-171`): subscribe via `schemaManager.getChangeNotifier().addListener(...)`; wire instantiation + dispose in `Database` (around `core/database.ts:134-136`). On `table_removed`/`table_modified` for any source table referenced by an MV body, set that MV's `stale = true`. Next reference (or next `refresh`) re-validates; on incompatible change, error: *"materialized view `X` is stale; source `Y` changed in an incompatible way — drop and recreate"*. (Track MV→source-table dependencies from the body's `collectTableRefs`, computed at create time.)

## Drop

`drop materialized view mv_name`:

1. (Phase 2 placeholder) detach any `DeltaSubscription` — no-op in v1.
2. Drop the backing table (reuse the existing drop-table path so its `table_removed` fires).
3. Remove the `MaterializedViewSchema` from the catalog.
4. Emit `materialized_view_removed`.

`drop materialized view` on a non-MV name (a plain table/view) errors clearly; `drop view`/`drop table` on an MV name likewise errors directing the user to `drop materialized view`.

## Out of scope (file in backlog/ after this lands — sibling ticket may file)

- `refresh ... concurrently` → `materialized-view-concurrent-refresh`.
- `on commit refresh` / incremental → `materialized-view-incremental-refresh`.
- Backing-module pluggability beyond `mem()` (AST is forward-compatible).
- Write-through → `materialized-view-writes-through-body` (gates on view-updateability).
- Lens-layer integration (separate plan tickets).

## Key tests (this ticket)

Add a new `test/logic/<nn>-materialized-views.sqllogic` (format: SQL stmts, `→ <JSON>` / `→ error: <msg>` expectations — see `test/logic/*.sqllogic`):

- **Initial materialization.** Insert into `t`; `create materialized view mv as select x, y from t`; `select * from mv` equals `select x, y from t`. With `order by` in the body, scan order matches.
- **Source mutation does NOT update MV (phase 1).** Insert into `t` after MV creation; MV rows unchanged until `refresh materialized view mv`; after refresh, rows updated.
- **Read-only boundary.** `insert into mv ...`, `update mv set ...`, `delete from mv` all → the read-only diagnostic. `insert into t ...` succeeds and is reflected after refresh.
- **Drop cascades.** `drop materialized view mv` drops the backing table; subsequent `select * from mv` errors "no such table/view".
- **Error paths.** `refresh materialized view missing`, `drop materialized view missing`, `drop materialized view <plain_table>` all error clearly.
- **PK fallback.** An MV whose body yields no `keysOf` key materializes with the all-columns PK (no crash; rows correct).
- **Schema-change staleness.** `drop table t` (a source) then reference `mv` → "stale" diagnostic. `alter table t` that breaks body planning → same.

Golden-plan (`test/plan/`, harness `test/plan/golden-plans.spec.ts`): a `select * from mv` plan contains a `TableReferenceNode` to the backing table, **not** an expanded body.

Change-scope: a `select * from mv` statement's `getChangeScope()` reports the **backing table** (watching the MV watches the backing table). Phase 2 sharpens to sources — note in the test.

Concurrent refresh (extend `test/vtab/concurrent-scan.spec.ts` shape): a reader iterating the MV while another connection `refresh`es blocks until refresh completes, then sees new state — no half-state.

## TODO

Phase A — parser & schema
- Add AST: `CreateMaterializedViewStmt` (`type: 'createMaterializedView'`, body `select: QueryExpr`, optional `usingModule` slot, `columns?`, `tags?`); `RefreshMaterializedViewStmt` (`type: 'refreshMaterializedView'`, `name`); extend `DropStmt.objectType` union with `'materializedView'`. (`parser/ast.ts`)
- Parser: branch in `createStatement()` for `materialized` after `create`; `REFRESH MATERIALIZED VIEW` entry; `drop materialized view` in `dropStatement()`. Follow the contextual-keyword convention (`CONTEXTUAL_KEYWORDS`, `parser/parser.ts:45`); `MATERIALIZED`/`REFRESH` handling consistent with existing `consumeKeyword`/`peekKeyword`. Add parser unit tests.
- `MaterializedViewSchema` in `schema/view.ts`; `materializedViews` map + methods on `Schema` (`schema/schema.ts`) with name-disjointness across tables/views/MVs; pass-throughs on `SchemaManager`. Exclude backing tables from user-facing catalog enumeration (`catalog.ts`).
- Add `materialized_view_added/refreshed/removed` to the `SchemaChangeEvent` union (`schema/change-events.ts`).

Phase B — runtime
- Build flow `buildCreateMaterializedViewStmt` (+ refresh/drop builders) and dispatch cases in `building/block.ts`. New plan nodes (sibling of `CreateViewNode`) + emitters under `runtime/emit/`.
- Create: optimize body, derive PK via `keysOf` (+ all-columns fallback), create backing table via `schemaManager.createTable`, bulk-insert body results; roll back on failure; populate `bodyHash` (`fnv1aHash`+`toBase64Url` of the optimized-body canonical form).
- Refresh: add `MemoryTableManager.replaceBaseLayer(...)` (factor the `commitTransaction` swap at `manager.ts:340`); latch + rebuild + atomic swap; emit `materialized_view_refreshed`.
- Drop: drop backing table + unregister MV + emit `materialized_view_removed`.

Phase C — resolution & invalidation
- Name-resolution branch in `building/select.ts:385-441` → backing-table `TableReferenceNode` for MV refs.
- Read-only write boundary: reject DML targeting an MV name with the standard diagnostic.
- `MaterializedViewManager` (mirror `AssertionEvaluator`): subscribe to schema changes, track MV→source deps, mark stale, staleness diagnostic at next reference/refresh. Wire instantiate + dispose in `core/database.ts`.

Phase D — tests & build
- sqllogic corpus + golden-plan + change-scope + concurrent-scan coverage per "Key tests".
- `yarn workspace @quereus/quereus build`, `yarn workspace @quereus/quereus test`, and lint green. Stream long test output with `Tee-Object` / `tee` per AGENTS.md.
- Hand off to review honestly: declarative-schema round-trip, differ/hasher `bodyHash` wiring, and docs are intentionally NOT in this ticket (sibling `materialized-view-declarative-docs`).
