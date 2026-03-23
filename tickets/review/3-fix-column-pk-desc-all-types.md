description: Fixed findColumnPKDefinition ignoring DESC direction for non-INTEGER column-level PKs
dependencies: none
files:
  packages/quereus/src/schema/table.ts
  packages/quereus/test/logic/40.1-pk-desc-direction.sqllogic
----

## What was fixed

In `findColumnPKDefinition` (table.ts:476), the `desc` flag was gated on
`col.logicalType.name === 'INTEGER'`, silently dropping DESC direction for TEXT, REAL,
and other non-INTEGER column-level PKs. Removed the type guard so `desc` is now
`col.pkDirection === 'desc'` — matching the table-level constraint path.

## One-line change

```typescript
// Before:
desc: col.logicalType.name === 'INTEGER' && col.pkDirection === 'desc',
// After:
desc: col.pkDirection === 'desc',
```

## Testing

`40.1-pk-desc-direction.sqllogic` covers 5 cases:
1. INTEGER PK DESC column-level (baseline)
2. TEXT PK DESC column-level (was broken, now fixed)
3. TEXT PK DESC table-level constraint (confirms correct path)
4. REAL PK DESC column-level (was broken, now fixed)
5. Composite PK with INTEGER DESC (baseline)

All 5 pass. Full test suite shows no regressions (1 pre-existing failure in `03.7-bigint-mixed-arithmetic` is unrelated).
