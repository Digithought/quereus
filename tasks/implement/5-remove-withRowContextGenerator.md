---
description: Convert remaining withRowContextGenerator call sites to createRowSlot and remove the function
dependencies: None — createRowSlot is proven in scan, join, filter, project, distinct
---

## Context

`withRowContextGenerator` calls `Map.set` + `Map.delete` on every row.  `createRowSlot` installs the context entry once and updates by cheap field write.  The first batch of high-frequency emitters (filter, project, distinct) was converted in the row-slot-generalization task.  Six call sites remain, all in inner loops:

### Remaining call sites

**`src/runtime/emit/cte-reference.ts`** — Streams every CTE result row through `withRowContextGenerator` just to set context and yield.  Direct `createRowSlot` replacement.

**`src/runtime/emit/internal-recursive-cte-ref.ts`** — Same pattern: streams working-table rows through `withRowContextGenerator` to set context and yield.  Direct replacement.

**`src/util/working-table-iterable.ts`** — Wraps a `Row[]` in `withRowContextGenerator` for recursive CTE iteration.  Replace with `createRowSlot` loop over the array.

**`src/runtime/emit/returning.ts`** — Streams DML executor rows, evaluates RETURNING projections per row.  Replace with `createRowSlot` + manual loop.

**`src/runtime/emit/update.ts`** — Streams source rows, evaluates assignment expressions per row.  Replace with `createRowSlot` + manual loop.

**`src/runtime/emit/window.ts`** — Uses `withAsyncRowContext` and `withRowContext` per row inside `processPartition`.  Convert to `createRowSlot` for the source descriptor and output descriptor.  Note: the ranking/aggregate helper functions also call `withAsyncRowContext` per peer-row; those should be converted too.

### After conversion

Once all call sites are converted, delete `withRowContextGenerator` from `src/runtime/context-helpers.ts` and remove all references from `docs/runtime.md`.  Update the JSDoc on `withAsyncRowContext` and `withRowContext` to remove the "legacy" framing — they remain useful for one-off evaluations but are no longer used in streaming loops.

### Key files

- `packages/quereus/src/runtime/context-helpers.ts` — `createRowSlot`, `withRowContextGenerator` (to be removed)
- `packages/quereus/src/runtime/emit/cte-reference.ts`
- `packages/quereus/src/runtime/emit/internal-recursive-cte-ref.ts`
- `packages/quereus/src/util/working-table-iterable.ts`
- `packages/quereus/src/runtime/emit/returning.ts`
- `packages/quereus/src/runtime/emit/update.ts`
- `packages/quereus/src/runtime/emit/window.ts`
- `docs/runtime.md`

