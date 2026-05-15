---
description: Make the store-mode UNIQUE-constraint enforcement honor `UniqueConstraintSchema.predicate` so partial-UNIQUE indexes (`CREATE UNIQUE INDEX ... WHERE ...`) treat rows outside the partial scope as not participating in uniqueness. Mirrors the reference implementation in `MemoryTableManager.checkSingleUniqueConstraint`.
files:
  packages/quereus-store/src/common/store-table.ts
  packages/quereus/src/vtab/memory/utils/predicate.ts
  packages/quereus/src/index.ts
  packages/quereus/src/vtab/memory/layer/manager.ts          # reference for shape of fix
  packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic
---

## Background

`StoreTable.checkUniqueConstraints` / `findUniqueConflict` (store-table.ts:941, 982) ignore
`uc.predicate`. After the cached-schema fix from
`store-table-create-index-schema-not-updated`, partial-UNIQUE constraints reach this code path
correctly but are enforced as if they were full-table — an insert whose row lies outside the
partial scope is rejected if some other (in-scope or out-of-scope) row shares the constrained
columns.

The reference path (`MemoryTableManager.checkSingleUniqueConstraint`,
`checkUniqueByScanning`, `uniqueColumnsChanged`) already evaluates the predicate against both
`newRow` and the candidate. We reuse the predicate compiler rather than reimplement.

## Shape of the fix

### 1. Promote `compilePredicate` to a public export of `@quereus/quereus`

It currently lives at `packages/quereus/src/vtab/memory/utils/predicate.ts` and is only
consumed internally. The store package imports from `@quereus/quereus` only — re-export the
compiler + the `CompiledPredicate` type from `packages/quereus/src/index.ts`.

Re-exporting from `vtab/memory/utils/...` is fine despite the `memory` path — the function is
schema-level (takes an `Expression` and a `ReadonlyArray<ColumnSchema>`) with no MemoryTable
coupling. No rename or relocation needed for this ticket; future cleanup could move it under
`schema/` but is out of scope.

### 2. Cache compiled predicates on the StoreTable

`StoreTable` keeps a `tableSchema`; add a small lazy map keyed by `UniqueConstraintSchema`
(by reference is sufficient — UC schemas are frozen and shared) to a `CompiledPredicate`.
Lookups happen per-row on hot paths, so don't recompile every call. Recompilation only needs
to happen when `tableSchema` changes; the simplest correct approach is to invalidate the
cache on `setTableSchema` / `updateTableSchema` (whatever the store-table API surface is —
inspect during implement). If no obvious schema-update hook exists, a `WeakMap<UniqueConstraintSchema, CompiledPredicate>` keyed on the constraint object is enough: a
new constraint object after CREATE/DROP INDEX produces a fresh compile, and the GC reclaims
the old entry.

### 3. Update `checkUniqueConstraints` (store-table.ts:941)

For each `uc`:

- If `uc.predicate` is set, compile (or fetch cached) the predicate. If `predicate.evaluate(newRow) !== true`, the new row is outside scope — `continue` to next UC (no
  conflict possible, regardless of what's stored). This mirrors `manager.ts:769-772`.
- Otherwise, behave exactly as today.

### 4. Update `findUniqueConflict` (store-table.ts:982)

Accept (or capture from the caller) the compiled predicate for the UC. In `matches`:

- After column-equality passes, if a predicate is set, evaluate it against the candidate row;
  return `null` if `predicate.evaluate(candidate) !== true`.

Suggested signature: pass the `UniqueConstraintSchema` instead of just `constrainedCols`, and
let `findUniqueConflict` resolve `columns` + `predicate` from it. Removes parallel-arg drift.

### 5. Update `uniqueColumnsChanged` (store-table.ts:917)

This currently only returns true when a constrained column changed. For partial UNIQUE, a
change to a column *referenced by the predicate* can also transition a row across the scope
boundary and must re-trigger the UNIQUE check. Match `manager.ts:705-728`:

```ts
for (const uc of ucs) {
    // covered columns
    for (const colIdx of uc.columns) { ... }
    // predicate-referenced columns
    if (uc.predicate) {
        const compiled = compileFor(uc);  // cached
        for (const colIdx of compiled.referencedColumns) {
            if (compareSqlValues(oldRow[colIdx], newRow[colIdx]) !== 0) return true;
        }
    }
}
```

`CompiledPredicate.referencedColumns` already exists for this exact purpose.

### 6. NULL-skip interaction

The existing fast-path `if (uc.columns.some(idx => newRow[idx] === null)) continue;` at
store-table.ts:952 stays. SQL UNIQUE-allows-multiple-NULLs semantics are independent of the
partial predicate. The order doesn't matter functionally — keep the NULL skip first so the
common case avoids predicate evaluation.

### 7. REPLACE / IGNORE paths

No special handling needed. Once a row is established as a conflict (both rows in-scope,
columns match, distinct PKs), IGNORE/REPLACE behavior is identical to today.

## Test target

`yarn test:store` →
`SQL Logic Tests (Store Mode) > File: 10.5.1-partial-indexes.sqllogic` must pass start to
finish. After the fix:

- Line 42 `insert into p_uniq values (2, 'inactive', 'A')` → ok (out of scope).
- Line 48 `insert into p_uniq values (3, 'active', 'A')` → UNIQUE constraint error (both in
  scope, code collision).
- Line 53 `insert into p_uniq values (4, 'active', 'A')` → ok (the prior `'active'` row was
  moved to `'archived'` by line 52, freeing the code).

The fixture also exercises `IS NULL` / compound predicates and an UPDATE that transitions a
row out of scope — all already supported by `compilePredicate` (verified in
predicate.ts:107-150, 152-216) and by the `uniqueColumnsChanged`-references-referenced-columns
piece above.

Don't add a new test file — the existing `10.5.1-partial-indexes.sqllogic` is the right
fixture and `yarn test:store` is the regression gate.

## Out of scope

- `schema-manager-drop-index-stale-unique-constraint` is its own ticket; don't touch
  derived-constraint drop logic here.
- The engine-side enforcement (`MemoryTableManager`) is already correct and tested under
  default `yarn test`. No changes there.

## TODO

- Export `compilePredicate` and `CompiledPredicate` from `packages/quereus/src/index.ts` (next
  to the schema/types exports).
- In `packages/quereus-store/src/common/store-table.ts`:
  - Add a per-table `WeakMap<UniqueConstraintSchema, CompiledPredicate>` cache + small
    `compileFor(uc): CompiledPredicate | undefined` helper that returns `undefined` when
    `uc.predicate` is absent and reuses the cached entry otherwise.
  - In `checkUniqueConstraints`, after the NULL fast-path: if `uc.predicate` is set and
    `compileFor(uc)!.evaluate(newRow) !== true`, `continue`.
  - Refactor `findUniqueConflict` to take the `UniqueConstraintSchema` (or at least the
    compiled predicate alongside the columns). In its `matches` closure, gate the candidate
    on `predicate?.evaluate(candidate) === true`.
  - Extend `uniqueColumnsChanged` to also return true when any column in
    `compileFor(uc).referencedColumns` differs between `oldRow` and `newRow`.
- Run `yarn test:store` and confirm `10.5.1-partial-indexes.sqllogic` passes. Also run the
  default `yarn test` and `yarn workspace @quereus/quereus-store run test` (or whatever the
  store package's lint/typecheck targets are) to make sure no regressions.
- Skim `packages/quereus-store/test/unique-constraints.spec.ts` for any partial-UNIQUE
  coverage; if absent, leave it — the sqllogic fixture is the canonical test. Don't add
  duplicative store-package tests.
