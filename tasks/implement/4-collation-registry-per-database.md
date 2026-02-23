---
description: Move collation registry from global module Map to per-Database instance
dependencies: none
---

# Per-Database Collation Registry — Implementation

## Overview

Collations are currently stored in a module-level global `Map` in `util/comparison.ts`. This makes registration shared across all `Database` instances in the same JS runtime. The fix is to move the collation `Map` onto `Database`, and have emitters resolve collations through `EmissionContext` (which already has `getCollation()` routing through `db._getCollation()`).

Performance is unaffected on the hot path — collation functions are pre-resolved at emit time and stored in closures. Only the resolution source changes (instance Map instead of global Map).

## Architecture

```
Registration:
  db.registerCollation(name, func) → db.collations.set(name, func)

Emit-time resolution (pre-resolved for hot path):
  emitter receives EmissionContext
    → ctx.resolveCollation(name)  [new method, with BINARY fallback]
      → ctx.db._getCollation(name)
        → db.collations.get(name)

Runtime: pre-resolved CollationFunction pointers — no change
```

## Key Files

### Source of truth (global → per-instance)
- `packages/quereus/src/util/comparison.ts` — global `collations` Map (line 14), `registerCollation()` (line 65), `getCollation()` (line 78), `resolveCollation()` (line 87)
- `packages/quereus/src/core/database.ts` — `registerCollation()` (line 974), `_getCollation()` (line 1046), `registerDefaultCollations()` (line 262)

### Emission context (already wired, needs resolveCollation)
- `packages/quereus/src/runtime/emission-context.ts` — `getCollation()` (line 175) already goes through `db._getCollation()`

### Emitters that call global `resolveCollation()` directly (need updating)
- `packages/quereus/src/runtime/emit/sort.ts:21`
- `packages/quereus/src/runtime/emit/distinct.ts:18`
- `packages/quereus/src/runtime/emit/aggregate.ts:85,107,114`
- `packages/quereus/src/runtime/emit/binary.ts:192`
- `packages/quereus/src/runtime/emit/between.ts:11`
- `packages/quereus/src/runtime/emit/join.ts:34`
- `packages/quereus/src/runtime/emit/merge-join.ts:65`
- `packages/quereus/src/runtime/emit/window.ts:52,60`
- `packages/quereus/src/runtime/emit/set-operation.ts:16`
- `packages/quereus/src/runtime/emit/subquery.ts:45`

### Public API
- `packages/quereus/src/index.ts` — exports `registerCollation`, `getCollation`, `resolveCollation` (lines 68-70)

### Tests
- `packages/quereus/test/plugins.spec.ts` — tests plugin collation registration
- `packages/quereus/test/capabilities.spec.ts` — collation usage tests
- Various `.sqllogic` files test COLLATE in ORDER BY, expressions, etc.

## TODO

### Phase 1: Per-database collation storage

- Add `private collations = new Map<string, CollationFunction>()` to `Database`
- Update `registerDefaultCollations()` to populate `this.collations` with BINARY, NOCASE, RTRIM instead of calling the global `registerCollation()`
- Update `Database.registerCollation()` to write to `this.collations` instead of delegating to the global function
- Update `Database._getCollation()` to read from `this.collations` instead of delegating to the global function

### Phase 2: EmissionContext resolveCollation

- Add `resolveCollation(collationName: string): CollationFunction` to `EmissionContext` — calls `this.getCollation()` (which tracks dependencies), falls back to BINARY_COLLATION if not found (with warning log, matching current behavior)

### Phase 3: Update all emitters

- In each emitter listed above, replace `resolveCollation(collationName)` with `ctx.resolveCollation(collationName)` where `ctx` is the `EmissionContext` parameter
- Remove unused `resolveCollation` imports from each emitter file
- Verify each emitter already receives `ctx: EmissionContext` (they all do per the emit function signatures)

### Phase 4: Public API / backward compat

- Keep the global `registerCollation`, `getCollation`, `resolveCollation` exports in `index.ts` for backward compatibility — they still work on the module-global Map for standalone comparison use cases, but are no longer the primary path
- Mark them with `@deprecated` JSDoc pointing to `db.registerCollation()` etc.

### Phase 5: Tests

- Add a test that creates two `Database` instances, registers a collation on one, and verifies it is NOT visible from the other
- Add a test that built-in collations (BINARY, NOCASE, RTRIM) work on a fresh `Database` without any explicit registration
- Verify existing collation tests still pass (plugins.spec.ts, capabilities.spec.ts, sqllogic tests)
- Build and run full test suite
