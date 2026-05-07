description: Reject HAVING references to non-grouped, non-aggregated columns
prereq:
files:
  packages/quereus/src/planner/building/select-aggregates.ts
  packages/quereus/test/logic/25.2-having-edge-cases.sqllogic
----

## Problem

A HAVING predicate that names a column not in the GROUP BY and not inside an aggregate is silently accepted:

```sql
select grp from hu group by grp having id > 0;
-- accepted; per SQL semantics, `id` should be rejected.
```

Per SQL: a HAVING predicate may reference only (i) GROUP BY expressions, (ii) the implicit single group when no GROUP BY is present (aggregates only), or (iii) aggregate expressions over the input relation. Bare references to non-grouped columns are a static error.

## Root cause

`buildHavingFilter` (`packages/quereus/src/planner/building/select-aggregates.ts:288-342`) builds a `hybridScope` that registers ALL source columns for HAVING resolution (lines 311-321):

```ts
sourceAttributes.forEach((sourceAttr, sourceIndex) => {
  …
  if (!alreadyRegistered) {
    hybridScope.registerSymbol(symbolName, (exp, s) =>
      new ColumnReferenceNode(s, exp, sourceAttr.type, sourceAttr.id, sourceIndex));
  }
});
```

This was added to let HAVING resolve the AggregateNode's exposed source columns, but it is too permissive — `id` resolves to a source column, the FilterNode evaluates it row-by-row over the AggregateNode output, and no error is raised.

## Expected behavior

After building the HAVING expression, walk its tree (excluding aggregate-function subtrees and relational subtrees) looking for `ColumnReferenceNode` nodes whose attribute id does NOT match a GROUP BY column. If any are found, throw `QuereusError` with a clear message naming the offending column and the HAVING clause.

The same check applies when there is no GROUP BY: HAVING is then over the implicit single group, so all bare column references are illegal — only aggregates are allowed.

## Implementation approach

Reuse the existing helper in `select-aggregates.ts`:

- `findUngroupedColumnRef(node, groupByAttrIds, groupByExprFingerprints)` (`select-aggregates.ts:209-238`) already does exactly the right walk — it stops at aggregate-function subtrees, stops at relational subtrees, stops when an entire subtree's AST fingerprint matches a GROUP BY expression, and returns the offending `ColumnReferenceNode`.

In `buildHavingFilter`, after `buildExpression(havingContext, havingClause, true)`:

```ts
const havingExpression = buildExpression(havingContext, havingClause, true);

const groupByAttrIds = new Set<number>();
const groupByExprFingerprints = new Set<string>();
for (const expr of groupByExpressions) {
  if (CapabilityDetectors.isColumnReference(expr)) groupByAttrIds.add(expr.attributeId);
  groupByExprFingerprints.add(expressionToString(expr.expression));
}
const ungrouped = findUngroupedColumnRef(havingExpression, groupByAttrIds, groupByExprFingerprints);
if (ungrouped) {
  throw new QuereusError(
    `HAVING references non-grouped column '${ungrouped.expression.name}'; ` +
    `HAVING may only reference GROUP BY columns or aggregate expressions`,
    StatusCode.ERROR,
    undefined,
    ungrouped.expression.loc?.start.line,
    ungrouped.expression.loc?.start.column,
  );
}

return new FilterNode(hybridScope, input, havingExpression);
```

For the `shouldPushHavingBelowAggregate` early path (`select-aggregates.ts:64-79`) we don't need this validation — that branch only runs when there is no GROUP BY *and* no aggregates, so HAVING is effectively a WHERE and bare references are well-defined.

Note: keep the source-column registration in `hybridScope` — it's still needed so that aggregate-function subtree arguments inside HAVING (e.g. `having sum(val) > 10`) can resolve their inner column references. The validation step happens AFTER expression building and rejects bare references that aren't inside an aggregate.

## Tests to enable / add

Uncomment the `-- TODO bug:` block in `packages/quereus/test/logic/25.2-having-edge-cases.sqllogic` lines 59-62:

```sql
select grp from hu group by grp having id > 0;
-- error: id
```

Add new negative coverage:

- `select grp, sum(val) from t group by grp having val > 0;` — error naming `val` (val is not in GROUP BY).
- `select grp, sum(val) from t group by grp having grp = 'a' and val > 0;` — error on `val` (the AND'd `grp` reference is fine).
- `select count(*) from t having id > 0;` — implicit-single-group form; error on `id`.

Add new positive coverage (assert these still work):

- `select grp from t group by grp having sum(val) > 0;` — aggregate is fine.
- `select grp from t group by grp having grp = 'a';` — GROUP BY column is fine.
- `select val * 2 as v2 from t group by val * 2 having val * 2 > 10;` — fingerprint-match path (`val * 2` matches the GROUP BY expression).

## Acceptance

- `yarn build`, `yarn test`, and `yarn lint` (in `packages/quereus`) pass.
- The newly enabled negative test in `25.2-having-edge-cases.sqllogic` produces the expected error.
- New positive tests pass; new negative tests error with a message naming the offending column.

## TODO

- Add the validation call in `buildHavingFilter` after expression building.
- Confirm `findUngroupedColumnRef` handles all relevant subtrees (CASE, BETWEEN, IN, scalar-subquery — it already does because it skips relational children).
- Uncomment the 25.2 test block, add new positive and negative test cases.
