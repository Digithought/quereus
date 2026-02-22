---
description: Generalize createRowSlot pattern to Filter, Project, and Distinct emitters
dependencies: None — createRowSlot already exists and is proven in scan.ts and join.ts

---

## Summary

Converted three high-frequency streaming emitters from per-row `Map.set`/`Map.delete` helpers to the `createRowSlot` pattern, eliminating 2×N unnecessary Map mutations per query.

### Changes

**`src/runtime/emit/filter.ts`** — Replaced `withRowContextGenerator` with a single `createRowSlot` for the source descriptor.

**`src/runtime/emit/project.ts`** — Replaced `withAsyncRowContext` + `withRowContextGenerator` with two `createRowSlot` calls (output slot created first so it's older; source slot created second so it wins in newest→oldest resolution).

**`src/runtime/emit/distinct.ts`** — Replaced `withRowContext` with a single `createRowSlot` for the output descriptor.

**`src/runtime/emit/array-index.ts`** — Fixed to search context newest→oldest (matching `resolveAttribute`), preventing stale-slot shadowing when multiple slots share a valid index.

**`src/runtime/emit/join.ts`** — Set right slot to null-padding before yielding unmatched LEFT JOIN rows, preventing stale right-side data from being visible downstream.

**`src/runtime/context-helpers.ts`** — Added JSDoc guidance to `withRowContext`, `withAsyncRowContext`, and `withRowContextGenerator` recommending `createRowSlot` for high-frequency streaming.

**`docs/runtime.md`** — Updated Key Emitter Patterns section to list `createRowSlot` as the preferred pattern for all streaming emitters, with the per-row helpers reserved for one-off/low-frequency use.

### Test Results

Full suite: 632 passing, 7 pending, 0 failing.

