---
description: Generalize createRowSlot pattern to Filter, Project, and Distinct emitters
dependencies: Runtime emit infrastructure
priority: 3
---

## Problem

The `createRowSlot()` pattern in `src/runtime/context-helpers.ts` installs a context entry once and updates it by reference — avoiding per-row `Map.set()/delete()` mutations. This efficient pattern is used by:

- `emit/join.ts` — uses `createRowSlot` correctly
- `emit/scan.ts` — uses `createRowSlot` correctly

However, several high-frequency emitters still use `withRowContextGenerator()` or `withAsyncRowContext()`, which perform `Map.set()` + `Map.delete()` on every row:

- `emit/filter.ts` — calls `withRowContextGenerator` per row
- `emit/project.ts` — calls `withAsyncRowContext` per row, plus wraps output in `withRowContextGenerator`
- `emit/distinct.ts` — calls `withRowContext` per row

For a 1000-row scan with a filter, that's 2000 unnecessary Map mutations (set + delete) that could be zero with the row slot pattern.

## Expected Behavior

All streaming emitters that process rows in a loop should use `createRowSlot` instead of per-row context mutation helpers. The `withRowContext`/`withAsyncRowContext` helpers should be reserved for one-off context pushes (e.g., constraint evaluation).

## Key Files

- `packages/quereus/src/runtime/context-helpers.ts` — `createRowSlot`, `withRowContextGenerator`
- `packages/quereus/src/runtime/emit/filter.ts`
- `packages/quereus/src/runtime/emit/project.ts`
- `packages/quereus/src/runtime/emit/distinct.ts`

