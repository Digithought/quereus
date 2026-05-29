description: Review the materialized-view engine substrate (phase 1, manual refresh) — parser/AST, dual-registered schema, MemoryTable-backed storage with atomic base-layer swap, query resolution to the backing table, read-only write boundary, and schema-change staleness. Build + full test suite + lint are green.
prereq:
files: packages/quereus/src/parser/ast.ts, packages/quereus/src/parser/parser.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/src/schema/view.ts, packages/quereus/src/schema/schema.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/schema/catalog.ts, packages/quereus/src/schema/change-events.ts, packages/quereus/src/planner/nodes/materialized-view-nodes.ts, packages/quereus/src/planner/nodes/plan-node-type.ts, packages/quereus/src/planner/building/materialized-view.ts, packages/quereus/src/planner/building/block.ts, packages/quereus/src/planner/building/select.ts, packages/quereus/src/planner/building/create-view.ts, packages/quereus/src/planner/building/schema-resolution.ts, packages/quereus/src/planner/building/insert.ts, packages/quereus/src/planner/building/update.ts, packages/quereus/src/planner/building/delete.ts, packages/quereus/src/runtime/emit/materialized-view.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/src/runtime/emit/drop-table.ts, packages/quereus/src/runtime/emit/drop-view.ts, packages/quereus/src/runtime/register.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/core/database.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/test/logic/51-materialized-views.sqllogic, packages/quereus/test/plan/materialized-view-plan.spec.ts, packages/quereus/test/parser.spec.ts, packages/quereus/test/logic/change-scope.spec.ts, packages/quereus/test/vtab/concurrent-scan.spec.ts
----

## What landed

Phase-1 materialized views as **keyed derived relations**: a stored relation defined by a query body, primary-keyed, addressable like any virtual table. Refresh is **manual full-refresh** only.

### Syntax (all implemented + parsed as contextual keywords — `MATERIALIZED`/`REFRESH` are NOT new reserved words)
```sql
create materialized view mv [(c1, c2)] [using mem(...)] as <query-expr> [with tags ...];
refresh materialized view mv;
drop materialized view mv;
```
- `using` clause sits **before** `as` (unambiguous w.r.t. the body). v1 accepts only `mem`/`memory`; anything else → "only mem() backing is supported … in v1" at build time. The AST slot (`moduleName`/`moduleArgs`) is forward-compatible.
- `order by` in the body is captured and **seeds the backing table's physical PK** (see "design choices").

### Data model
- **Dual registration**: the backing table is a normal `TableSchema` in `Schema.tables` under a reserved derived name `sqlite_mv_<mvname>` (`backingTableNameFor` in `schema/view.ts`); the `MaterializedViewSchema` lives in a new `Schema.materializedViews` map. Name-disjointness is enforced across tables, views, AND materialized views (`schema.ts`). Backing tables are excluded from user-facing catalog enumeration (`catalog.ts`).
- `MaterializedViewSchema` carries: `selectAst` (body, retained for the sibling declarative ticket), `backingTableName`, `primaryKey` (logical, from `keysOf`), `bodyHash` (`fnv1aHash`+`toBase64Url` of the canonical body SQL — populated here; the differ that consumes it is the sibling ticket), `ordering`, `sourceTables` (for staleness), `stale`.
- New change events: `materialized_view_added` / `materialized_view_refreshed` / `materialized_view_removed`.

### Create / refresh / drop (runtime emitters in `runtime/emit/materialized-view.ts` + helpers)
- **Create**: derive backing shape from the *optimized* body (`db.getPlan` → root relation's columns/types + `keysOf` PK + physical `ordering`); create the backing table via the new `SchemaManager.createBackingTable(schema)` (reuses `module.create` + `finalizeCreatedTableSchema` + `addTable` + `table_added`); run the body and bulk-load via `MemoryTableManager.replaceBaseLayer`. **Rolls back** (drops the backing table, does not register the MV) on any failure during fill.
- **Refresh**: re-run the body into a fresh `BaseLayer` and **atomically swap** it in via the new `MemoryTableManager.replaceBaseLayer(rows)` (acquires the `MemoryTable.SchemaChange:<schema>.<table>` latch, calls `ensureSchemaChangeSafety`, swaps `baseLayer`/`_currentCommittedLayer`, re-points connections). Stale MVs re-validate the body first.
- **Drop**: drops the backing table (fires `table_removed`), removes the MV record, fires `materialized_view_removed`.

### Query resolution & boundaries
- `building/select.ts`: an MV reference resolves to a **`TableReferenceNode` against the backing table** (the `else if (mvSchema)` branch), NOT a body expansion. The optimizer/`getChangeScope` therefore see the backing table for free.
- **Read-only**: `insert/update/delete` targeting an MV name → "materialized views are read-only; write to the source tables instead." (`assertNotMaterializedView` in `schema-resolution.ts`, wired into all three DML builders). `drop table`/`drop view` on an MV name → "use DROP MATERIALIZED VIEW"; `drop materialized view` on a plain table/view → directs to DROP TABLE/VIEW.
- **Staleness**: `MaterializedViewManager` (`core/database-materialized-views.ts`, mirrors `AssertionEvaluator`, wired into `Database` ctor/`close`) subscribes to schema changes and sets `stale=true` when a `table_removed`/`table_modified` hits any MV's `sourceTables`. The next reference re-validates the body and errors with the staleness diagnostic on an incompatible change; the next successful refresh clears the flag.

## Validation done (all green)
- `yarn workspace @quereus/quereus build` — clean.
- Full `packages/quereus` mocha suite — **3703 passing, 0 failing, 9 pending** (includes the two pre-existing DROP-error-message assertions updated for the new "MATERIALIZED VIEW" wording in `10.5-indexes.sqllogic` and `90.1-parse-errors.sqllogic`).
- `yarn workspace @quereus/quereus lint` — clean.

### Tests added
- `test/logic/51-materialized-views.sqllogic`: initial materialization (incl. `order by` scan order), source-mutation-doesn't-update-until-refresh, read-only boundary (+ source still writable), drop cascade, error paths (refresh/drop missing, drop-mv-on-table, drop-table/view-on-mv), PK fallback, schema-change staleness (drop source + incompatible alter).
- `test/parser.spec.ts` → `Materialized Views`: create/columns/if-not-exists/`using`/refresh/drop parsing + ast-stringify round-trip (incl. `drop materialized view`, not `drop materializedview`).
- `test/plan/materialized-view-plan.spec.ts`: `select * from mv` plan references `sqlite_mv_mv` via `TableReference`, not the body source `t`.
- `test/logic/change-scope.spec.ts`: an MV reference reports the **backing table** in its change scope (Phase-2 will sharpen to sources).
- `test/vtab/concurrent-scan.spec.ts`: `replaceBaseLayer` refresh is atomic — an in-flight scan keeps its pre-refresh snapshot; a fresh scan sees fully-new state (never half).

## Reviewer focus / known gaps (treat tests as a floor)
1. **`order by` seeds the *physical* PK, diverging from the logical PK.** To make "scan order matches" hold on a btree (which scans in PK order), `computeBackingPrimaryKey` makes the backing table's `primaryKeyDefinition` lead with the ordering columns (then the logical key for uniqueness). `MaterializedViewSchema.primaryKey` keeps the logical `keysOf` identity. Confirm this divergence is acceptable and that Phase-2 incremental (which addresses backing rows by `MaterializedViewSchema.primaryKey`) can reconcile — or push back if the backing PK should equal the logical PK and ordering should instead be a read-time sort / secondary index.
2. **PK fallback + duplicate rows.** A bag body (no `keysOf` key) materializes on the all-columns PK. If the body emits duplicate rows, `replaceBaseLayer` throws a UNIQUE PK error and create/refresh fails. The PK-fallback test uses distinct rows. This is an inherent limitation of "keyed derived relations" in v1 — verify the error is acceptable (vs. silently de-duping or a clearer diagnostic).
3. **Body is evaluated twice on create** (`db.getPlan` for shape + a separate `prepare`/`_iterateRowsRaw` for rows). Correct but redundant; fine for rare DDL. Worth a look if a single-pass path is cheap.
4. **Concurrency contract nuance.** The ticket said "a reader blocks on the latch"; the implementation instead relies on the memory table's start-of-call **snapshot isolation** (readers don't block; the swap is a single synchronous assignment under the latch). Net effect — "never half-state" — holds and is tested. Confirm the snapshot approach is preferred over actual reader-blocking.
5. **Schema resolution for MV ignores the schema search path** (`select.ts` uses `table.schema || getCurrentSchemaName()`, not the path that tables use). Fine for single-schema 'main' usage; an MV in a non-current schema referenced unqualified won't resolve as an MV. Minor; flag if cross-schema MV references matter now.
6. **`getSchemaItem` not MV-aware.** Introspection paths using `SchemaManager.getSchemaItem` won't surface MVs (only tables/views). User-facing catalog listing correctly hides backing tables; MV catalog emission is the sibling ticket.
7. **DDL inside a rolled-back transaction.** Create's backing-table `module.create` is immediate (not catalog-transactional), same as `CREATE TABLE`. Not made transactional here.
8. **`bodyHash` algorithm.** Hashes canonical body SQL (`astToString`), not a plan-structure serialization (plan serialization embeds unstable node ids). Stable per-body and changes when the body changes — sufficient for the sibling differ, but confirm the differ doesn't need a structure-level hash.

## Explicitly NOT in this ticket (sibling `materialized-view-declarative-docs`, which prereqs this)
- Declarative-schema round-trip (catalog/DDL emission of MVs), the schema-differ/hasher `bodyHash` wiring, and `docs/materialized-views.md`.

## Out of scope (file in backlog/ if not already): `materialized-view-concurrent-refresh`, `materialized-view-incremental-refresh`, backing-module pluggability beyond `mem()`, `materialized-view-writes-through-body` (gates on view-updateability), lens-layer integration.
