---
description: Review: store-mode UNIQUE-constraint enforcement now honors `UniqueConstraintSchema.predicate` so partial-UNIQUE (`CREATE UNIQUE INDEX ... WHERE ...`) treats rows outside the partial scope as not participating in uniqueness. Two layers needed the fix — `StoreTable` and the wrapping `IsolatedTable`.
files:
  packages/quereus/src/index.ts
  packages/quereus-store/src/common/store-table.ts
  packages/quereus-isolation/src/isolated-table.ts
  packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic
---

## What landed

Mirrors `MemoryTableManager.checkSingleUniqueConstraint` /
`uniqueColumnsChanged` (`packages/quereus/src/vtab/memory/layer/manager.ts:705-799`).

### 1. New public exports from `@quereus/quereus`

`packages/quereus/src/index.ts`:
- `compilePredicate` (function) — re-exported from `./vtab/memory/utils/predicate.js`.
- `CompiledPredicate` (type) — same source.
- `UniqueConstraintSchema` (type) — re-exported from `./schema/table.js`.

The compiler lives under `vtab/memory/utils/` but is schema-level (no MemoryTable
coupling): it takes an `Expression` and `ReadonlyArray<ColumnSchema>`. A future
cleanup could relocate it under `schema/` but is out of scope.

### 2. `StoreTable.checkUniqueConstraints` / `findUniqueConflict` / `uniqueColumnsChanged`

`packages/quereus-store/src/common/store-table.ts`:

- New private `WeakMap<UniqueConstraintSchema, CompiledPredicate>` cache + a
  `compileFor(uc)` helper that returns `undefined` for full-table UCs and a
  memoized `CompiledPredicate` for partial ones. WeakMap-keyed on the
  constraint-object identity so CREATE/DROP INDEX (which produces a new UC
  object) implicitly invalidates the cache and GC reclaims old entries.
- `checkUniqueConstraints` — after the NULL fast-path, if `uc.predicate` is set
  and `predicate.evaluate(newRow) !== true`, `continue` to the next UC. The new
  row is outside the partial scope and contributes nothing to uniqueness.
- `findUniqueConflict` — signature now takes the `UniqueConstraintSchema` and
  the (already-resolved) compiled predicate. In its `matches` closure, after
  column-equality passes, gates the candidate on
  `predicate?.evaluate(candidate) === true` — out-of-scope candidates never
  count as conflicts.
- `uniqueColumnsChanged` — also returns true when any column in
  `compiled.referencedColumns` differs between `oldRow` and `newRow`. Required
  so a same-PK UPDATE that transitions a row across the predicate scope
  re-triggers the UNIQUE check.

### 3. `IsolatedTable.checkMergedUniqueConstraints` / `findMergedUniqueConflict`

`packages/quereus-isolation/src/isolated-table.ts`:

**Scope expansion (not in the original ticket's files list, but required for the
target test to pass).** Store-mode tests wire `createIsolatedStoreModule` which
wraps the StoreTable with `IsolatedTable`. `IsolatedTable.update` runs its own
UNIQUE check (`checkMergedUniqueConstraints`) on the merged underlying-plus-
overlay view before delegating to the overlay's MemoryTable. Without the
isolation-layer fix, partial UNIQUE still false-conflicts at this layer.

Same pattern: private `WeakMap` cache, `compileFor(uc)` helper, predicate-aware
candidate filtering. Added before `findMergedUniqueConflict`'s `selfPks`/
tombstone check, and as the early-skip in `checkMergedUniqueConstraints` when
the newRow is out of scope.

The `IsolatedTable` does not have an analogue of `uniqueColumnsChanged` — it
unconditionally runs the merged UNIQUE check on every UPDATE, so the change to
`uniqueColumnsChanged` in `StoreTable` is sufficient for the store layer's
own optimization.

## Test target

`yarn test:store` → `SQL Logic Tests (Store Mode) > File:
10.5.1-partial-indexes.sqllogic` now passes (verified, ~417ms).

Specifically:
- Line 42 `insert into p_uniq values (2, 'inactive', 'A')` → ok (out of scope).
- Line 48 `insert into p_uniq values (3, 'active', 'A')` → UNIQUE constraint
  error (both in scope, code collision) — expected, caught.
- Line 52 `update p_uniq set status = 'archived' where id = 1` → ok
  (UPDATE re-checks because `status` is in `referencedColumns`, evaluation on
  newRow is false, UC is skipped).
- Line 53 `insert into p_uniq values (4, 'active', 'A')` → ok (the prior
  `'active'` row is now `'archived'`, so the partial scope no longer holds 'A').

Fixture also exercises `IS NULL` predicates and compound `AND` predicates in
the same file (scenarios 3-5) — those already worked before this change
because they don't involve UNIQUE, but they continue to work.

## Pre-existing latent issue exposed (separate ticket)

Before this fix, mocha bailed out of store-mode logic tests at the
10.5.1-partial-indexes failure (count: 577 passing). After the fix,
mocha continues and runs every subsequent file; the count jumps to 587
passing, and a new failure surfaces: `102.1-unique-edge-cases.sqllogic:60`:

```sql
create table u2_a (k text primary key, x text not null);
insert into u2_a values ('r1', 'dup'), ('r2', 'dup');
create unique index u2_a_x on u2_a(x);
-- error: UNIQUE  <-- expected, but not raised in store mode
```

`StoreModule.createIndex` / `buildIndexEntries`
(`packages/quereus-store/src/common/store-module.ts:308-407`) blindly seeds
secondary-index entries without validating uniqueness against existing rows.
This is independent of the partial-UNIQUE path and predates this work; the
102.1 test was simply unreachable while 10.5.1 failed first.

Separate fix ticket filed:
`tickets/fix/store-create-unique-index-skips-existing-duplicates.md`.

## Validation run

- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/store run build` — clean.
- `yarn workspace @quereus/isolation run build` — clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn test` — quereus suite: 2942 passing, 2 pending, 0 failing. The 2
  sample-plugins failures (`Comprehensive Demo Plugin > supports delete/update`)
  pre-exist on baseline (verified by stashing changes) and are unrelated.
- `yarn test:store` — 587 passing, 2 pending, 1 failing. The single failure
  is the 102.1 file noted above (pre-existing, separately ticketed). Target
  file `10.5.1-partial-indexes.sqllogic` passes.

## Reviewer focus

- Sanity-check the scope expansion into `IsolatedTable`. The original ticket
  listed only `store-table.ts`. The merged-view UNIQUE check there reproduces
  the same logic for the wrapping layer; without it the store-mode test does
  not pass. Confirm this is the right boundary and that the test fixture
  isn't artificial.
- The `WeakMap` cache assumes UC objects are stable across check calls within
  one INSERT/UPDATE. After CREATE/DROP INDEX, `StoreModule.createIndex` calls
  `table.updateSchema(updatedSchema)` (store-module.ts:358), which replaces
  the whole schema and synthesizes a new UC object — the old entry becomes
  GC-eligible. Double-check that no path mutates an existing UC in place;
  if it does, the cache would return a stale compile.
- `uniqueColumnsChanged` change: confirm the same-PK-UPDATE skip-decision is
  correct. The change is conservative (returns true more often, never less);
  the only cost is an extra `checkUniqueConstraints` call when a column
  referenced by the predicate but not in `uc.columns` changes, which mirrors
  the memory-table reference impl.
- Hot-path cost: per-row, partial UCs now evaluate the predicate twice (once
  on `newRow`, once per candidate that passes column-equality). Out-of-scope
  newRows short-circuit before any scan, so the typical cost is one
  predicate eval per write. For full-table UCs, `compileFor` returns
  undefined and behavior is unchanged.
