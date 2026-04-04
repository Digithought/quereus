description: NULLS FIRST/LAST ordering is reversed when combined with DESC
dependencies: none
files:
  - packages/quereus/src/util/comparison.ts (compareWithOrderByFast, lines ~277-314)
  - packages/quereus/test/utility-edge-cases.spec.ts (lines ~455-471, unit tests match buggy behavior)
  - docs/sql.md (lines 1297-1298, documents correct standard behavior)
----

## Bug

`ORDER BY col DESC NULLS FIRST` should put NULLs before non-NULL values (per SQL standard and docs/sql.md:1297).
Instead, NULLs appear **last**. The reverse also applies: `DESC NULLS LAST` puts NULLs **first**.

### Root cause

In `compareWithOrderByFast` (comparison.ts), the DESC direction negation (`-comparison`) is applied to the
entire comparison result, including the NULL-ordering portion. When `NULLS FIRST` sets `comparison = -1`
(null before non-null), the DESC negation flips it to `+1` (null after non-null).

```
// Current logic (simplified):
if (a === null) {
    if (nullsOrdering === FIRST) comparison = -1;  // nulls first
    else if (nullsOrdering === LAST) comparison = 1;
    else comparison = direction === DESC ? 1 : -1;  // default
}
return direction === DESC ? -comparison : comparison;  // ← negates NULLS FIRST/LAST too
```

### Expected behavior

Explicit `NULLS FIRST` and `NULLS LAST` should be absolute — not affected by ASC/DESC direction.
The DESC negation should only apply to non-NULL value comparisons.

### Reproducer

```sql
create table t (id integer primary key, txt text null);
insert into t values (1,'a'),(2,'b'),(3,null),(4,null);
select id, txt from t order by txt desc nulls first, id;
-- Expected: null,null,b,a
-- Actual:   b,a,null,null
```

### Fix approach

When explicit NULLS ordering is specified, return the NULL comparison directly without applying DESC negation:

```typescript
// For explicit NULLS ordering, return immediately (don't negate for DESC)
if (a === null) {
    if (nullsOrdering === NullsOrdering.FIRST) return -1;
    if (nullsOrdering === NullsOrdering.LAST) return 1;
    // Default: continue to apply direction negation below
    comparison = direction === SortDirection.DESC ? 1 : -1;
}
```

Also update the unit test in `utility-edge-cases.spec.ts` which currently asserts the buggy behavior.

### Notes

Found during review of edge-case test `21-null-edge-cases.sqllogic:56-57`, which documents the current (buggy) behavior.
Once fixed, that test's expected output for `DESC NULLS FIRST` will need updating too.
