description: The isolation-wrapped store path (createIsolatedStoreModule / isolated-table.ts, exercised by `yarn test:store`) enforces UNIQUE via its own merged-view (overlay + underlying) detection and never calls store-table.ts's covering-MV routing. So a row-time covering MV's backing table is NOT maintained for that layer's internal REPLACE evictions — a `select` from the MV after such an eviction can show a stale row on the isolation path. Decide whether the isolation layer should route UNIQUE conflict resolution through the covering MV like the direct store/memory paths do.
prereq:
files: packages/quereus-isolation/src/isolated-table.ts, packages/quereus-store/src/common/store-table.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/test/logic/54-covering-mv-enforcement.sqllogic
----

## Problem

`covering-structure-mv-rowtime-enforcement` made the `materialized-view` arm of
`CoveringStructure` a live enforcement path for the **memory** source
(`MemoryTableManager`) and the **direct** store source (`StoreTable.checkUniqueConstraints`
→ `findUniqueConflictViaCoveringMv`). Both route conflict resolution through the covering
MV's backing table and, on a REPLACE eviction, drive
`_maintainRowTimeCoveringStructures({ op: 'delete', oldRow })` so the evicted source row's
backing entry is dropped within the statement.

The **isolation-wrapped** store path is different. `createIsolatedStoreModule`
(quereus-isolation) wraps the store in `isolated-table.ts`, which enforces UNIQUE via its
own merged-view (snapshot overlay + underlying) detection — it never calls
`store-table.ts`'s `checkUniqueConstraints`, so the covering-MV routing and its eviction
maintenance never run on that path.

Observable consequence: enforcement *outcomes* under the isolation sweep are correct (its
own logic), but a row-time covering MV's backing is **not maintained for the isolation
layer's internal REPLACE evictions** — a `select` from the MV after such an eviction would
show a stale (evicted) row on that path. Because of this, `54-covering-mv-enforcement.sqllogic`
deliberately **omits** the backing-consistency (`select from mv`) assertions for
internal-eviction cases when run under `yarn test:store`; those assertions live only in the
memory spec (`test/covering-structure.spec.ts`) and the direct store-table spec
(`quereus-store/test/unique-constraints.spec.ts`).

## Wanted

- Decide whether `isolated-table.ts` should route UNIQUE conflict resolution through the
  covering MV (via the same `_findRowTimeCoveringStructure` / `_lookupCoveringConflicts` /
  `_maintainRowTimeCoveringStructures` surface) so the backing stays consistent for its
  internal evictions, OR document that the isolation layer intentionally owns its own
  enforcement and the covering MV's backing is best-effort there.
- If routed: add the omitted `select from mv` backing-consistency assertions to
  `54-covering-mv-enforcement.sqllogic` so the store sweep covers them too.

## Notes

- Documented in `docs/materialized-views.md` § "Enforcement through a row-time covering MV"
  → "Store-module parity" (the isolation-wrapped path paragraph) and in the inline NOTE in
  `54-covering-mv-enforcement.sqllogic`.
