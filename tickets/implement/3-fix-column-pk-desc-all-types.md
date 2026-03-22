description: findColumnPKDefinition ignores DESC direction for non-INTEGER column-level PKs
dependencies: none
files:
  packages/quereus/src/schema/table.ts
  packages/quereus/test/logic/40.1-pk-desc-direction.sqllogic
----

## Root Cause

In `findColumnPKDefinition` (table.ts:474-479), the `desc` flag is gated on `col.logicalType.name === 'INTEGER'`:

```typescript
desc: col.logicalType.name === 'INTEGER' && col.pkDirection === 'desc',
```

This means `CREATE TABLE t (name TEXT PRIMARY KEY DESC)` silently drops the DESC direction.
The table-level constraint path (`findConstraintPKDefinition`, line 445) correctly uses
`desc: colInfo.direction === 'desc'` with no type restriction, confirming this is a bug
rather than a deliberate design choice.

## Fix

**table.ts line 476** — remove the INTEGER type guard:

```typescript
// Before:
desc: col.logicalType.name === 'INTEGER' && col.pkDirection === 'desc',
// After:
desc: col.pkDirection === 'desc',
```

This brings column-level PK handling in line with the table-level constraint path.

## Reproducing Test

`packages/quereus/test/logic/40.1-pk-desc-direction.sqllogic` — already written and confirms:
- Test 1: INTEGER PK DESC column-level — passes (baseline)
- Test 2: TEXT PK DESC column-level — **FAILS** (the bug)
- Test 3: TEXT PK DESC table-level constraint — passes (correct path)
- Test 4: REAL PK DESC column-level — fails (same bug)
- Test 5: Composite with INTEGER DESC — passes (baseline)

After the fix, all 5 tests should pass.

## TODO

- [ ] Apply the one-line fix to table.ts:476
- [ ] Run the reproducing test to confirm all pass
- [ ] Run full test suite to check for regressions
