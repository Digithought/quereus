---
description: Support HAVING with COUNT(DISTINCT ...) and other DISTINCT aggregates
dependencies: Parser (ast.ts), planner (select-aggregates.ts, function-call.ts), runtime (aggregate.ts)
---

## Feature

`HAVING` clauses should support aggregate functions with the `DISTINCT` modifier, such as `HAVING COUNT(DISTINCT col) > 1`. Currently, `COUNT(DISTINCT ...)` works in `SELECT` expressions and `HAVING` works with non-distinct aggregates, but combining them — e.g. `HAVING COUNT(DISTINCT col) > n` — is not supported.

This applies to all aggregate functions that accept `DISTINCT`, not just `COUNT`.

## Expected Behavior

```sql
-- Filter groups by distinct count
select grp from t group by grp having count(distinct val) > 1;

-- With other distinct aggregates
select grp from t group by grp having sum(distinct val) > 100;

-- Nested in expressions
select grp from t group by grp having count(distinct val) + count(distinct other) > 3;
```

## Use Case

This is standard SQL (SQL:1999+) and a common pattern for filtering groups based on the number of unique values. Any real-world analytics or reporting query may rely on this.
