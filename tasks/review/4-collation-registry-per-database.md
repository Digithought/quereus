---
description: Per-database collation registry — review
dependencies: none
---

# Per-Database Collation Registry — Review

## Summary

Moved collation registration from a module-level global `Map` to a per-`Database` instance `Map`. Each `Database` now owns its own collation registry, initialized with BINARY, NOCASE, and RTRIM. `db.registerCollation()` writes to the instance-local registry only.

## Changes

### Core
- **`packages/quereus/src/core/database.ts`** — Added `private readonly collations = new Map<string, CollationFunction>()`. `registerCollation()` and `_getCollation()` now operate on the instance map instead of delegating to the global.
- **`packages/quereus/src/runtime/emission-context.ts`** — Added `resolveCollation(collationName)` method with BINARY fast-path and fallback, using `getCollation()` (which tracks dependencies).

### Emitters (10 files)
All emitters updated to use `ctx.resolveCollation()` instead of the global `resolveCollation()`:
- `sort.ts`, `distinct.ts`, `between.ts`, `binary.ts`, `aggregate.ts`, `join.ts`, `merge-join.ts`, `window.ts`, `set-operation.ts`, `subquery.ts`

### Public API
- Global `registerCollation`, `getCollation`, `resolveCollation` in `util/comparison.ts` marked `@deprecated` with guidance to use per-database methods. Retained for backward compatibility and vtab/memory internal use (built-in collation fallback).

## Testing

- **New test file**: `packages/quereus/test/collation-isolation.spec.ts` with 3 tests:
  1. Built-in collations work on a fresh Database
  2. Custom collation on db1 is not visible from db2
  3. Overriding NOCASE on db1 does not affect db2
- Full test suite: 672 passing, 0 failing

## Known limitation

vtab/memory internal utilities (`primary-key.ts`, `index.ts`) still use the global `resolveCollation` for column definition collations. This works for built-in collations (always present in the global Map). Custom collations on vtab column definitions would need deeper vtab infrastructure changes to thread a resolver through — out of scope for this task.
