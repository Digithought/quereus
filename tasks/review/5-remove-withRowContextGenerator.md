---
description: Converted all withRowContextGenerator call sites to createRowSlot and removed the function
dependencies: None
---

## Summary

Converted all 7 remaining `withRowContextGenerator` call sites to use the `createRowSlot` pattern (install context entry once, update by cheap field write instead of per-row `Map.set`/`Map.delete`). Deleted `withRowContextGenerator` from `context-helpers.ts` and cleaned up `docs/runtime.md`.

## Changed files

- **`src/runtime/emit/cte-reference.ts`** — Direct `createRowSlot` replacement.
- **`src/runtime/emit/internal-recursive-cte-ref.ts`** — Direct `createRowSlot` replacement.
- **`src/util/working-table-iterable.ts`** — Simplified to a plain row-yielding iterable; context management moved to consumer (`InternalRecursiveCTERef`).
- **`src/runtime/emit/returning.ts`** — `createRowSlot` + manual loop.
- **`src/runtime/emit/update.ts`** — `createRowSlot` + manual loop.
- **`src/runtime/emit/window.ts`** — `createRowSlot` for source descriptor; shared slot passed through helper functions (`evaluateFrameAggregate`, `evaluateRankingFunction`).
- **`src/runtime/emit/table-valued-function.ts`** — Discovered during build; converted to `createRowSlot`.
- **`src/runtime/emit/recursive-cte.ts`** — Removed dead `withRowContext` wrapper calls and unused `rowDescriptor`/`buildRowDescriptor` import.
- **`src/runtime/context-helpers.ts`** — Deleted `withRowContextGenerator`. Updated JSDoc on `withAsyncRowContext`/`withRowContext` to remove "legacy" framing.
- **`src/planner/nodes/cte-reference-node.ts`** — Fixed attribute ID collision: `buildAttributes()` now always generates fresh IDs via `PlanNode.nextAttrId()` instead of conditionally reusing source CTE attribute IDs. This prevents `resolveAttribute`'s newest→oldest search from finding a stale slot from `InternalRecursiveCTERef` that shares the same IDs.
- **`docs/runtime.md`** — Removed all `withRowContextGenerator` references.

## Bug fixed during conversion

The `createRowSlot` migration exposed a latent attribute-ID collision between `CTEReferenceNode` and `InternalRecursiveCTERefNode`. When no alias was present, `CTEReferenceNode.buildAttributes()` reused the source CTE's attribute IDs, which collided with `InternalRecursiveCTERef`'s identically-derived IDs. Under the old `withRowContextGenerator` (which re-inserted into the Map on every row), this collision was masked. Under `createRowSlot` (which installs once), the `InternalRecursiveCTERef`'s newer context slot permanently shadowed the `cte_ref`'s older slot, causing recursive CTE queries to return stale base-case values.

Fix: `CTEReferenceNode.buildAttributes()` now unconditionally generates fresh attribute IDs.

## Testing

All 632 tests pass (7 pending). Specific coverage:
- `07.5-window.sqllogic` — Window function tests including RANK(), ROW_NUMBER(), aggregate frames
- `13-cte.sqllogic` — CTE and recursive CTE tests including hierarchical path traversal

