---
description: Two narrow tightenings of the predicate-contradiction analysis surfaced while reviewing `tickets/complete/2-optimizer-predicate-contradiction-detection.md`. (a) `x IN ()` should fold to `unsat`; (b) the filter-contradiction rule should short-circuit on `lit-null` predicates instead of dispatching to the sat-checker.
prereq:
files:
  - packages/quereus/src/planner/analysis/sat-checker.ts
  - packages/quereus/src/planner/rules/predicate/rule-filter-contradiction.ts
  - packages/quereus/src/planner/rules/predicate/rule-empty-relation-folding.ts
  - packages/quereus/test/optimizer/predicate-contradiction.spec.ts
---

## Background

The predicate-contradiction rule (Structural pass priority 27) detects unsatisfiable `Filter` predicates via `analysis/sat-checker.ts` and folds them to `EmptyRelationNode`. Two small gaps were filed during review of that ticket — neither is a regression; both are easy wins.

The sibling rule `ruleFilterFoldEmpty` (also priority 27) already collapses `Filter(_, lit-null | lit-false | lit-0 | lit-0n)` to `EmptyRelationNode` via its `isLiteralFalsy` helper. The two changes below align the contradiction rule and sat-checker with that broader notion of "provably empty."

## 1. `x IN ()` → `unsat`

In `sat-checker.ts` (`absorb` for `InNode`, around line 380):

```ts
if (!conj.values || conj.values.length === 0) {
    // `x IN ()` is always false → unsat trivially, but the parser usually
    // rejects this; treat conservatively.
    markUnknownForColumns(conj, accs, attrIndex);
    return;
}
```

`x IN ()` is provably empty whenever the parser produces it. The conservative bail-out is unnecessary — replace it with an `intersectAllowed(getOrCreate(accs, col), [], col, cmp)` on a resolvable column ref so the existing "filtered.length === 0 → unsat" decision step catches it. If the condition is not a resolvable column ref (e.g. `(a + b) IN ()`), the safe move is still to mark unknown.

Concretely:
- Resolve `col = columnOf(conj.condition, attrIndex)` *before* checking `values.length`.
- If `col === undefined` → `markUnknownForColumns(...)` (unchanged).
- Otherwise, treat an empty `values` list as an empty `allowedValues` — call `intersectAllowed(getOrCreate(accs, col), [], col, cmp)`. The decision loop at the bottom of `checkSatisfiability` already returns `'unsat'` when a column's `filtered.length === 0`.

## 2. `Filter(_, lit-null)` guard

In `rule-filter-contradiction.ts:44`:

```ts
if (node.predicate instanceof LiteralNode && node.predicate.expression.value === false) {
    return null;
}
```

Mirror `isLiteralFalsy` from `rule-empty-relation-folding.ts:67`. The contradiction rule should bail when the predicate is `LiteralNode` with value `false | null | 0 | 0n` — the sibling fold-empty rule will collapse those anyway, and the sat-checker would otherwise be invoked for nothing (currently returns `'sat'` for `lit-null`, since there are no column refs).

Don't duplicate the helper — export `isLiteralFalsy` from `rule-empty-relation-folding.ts` (or factor it to a shared location under `planner/analysis/`) and import it here. Module-internal helpers commonly live near their first user; if no obvious home presents itself, exporting from `rule-empty-relation-folding.ts` is fine — both rules are tightly co-located.

## Tests

Add to `test/optimizer/predicate-contradiction.spec.ts`:

- Unit test at the checker layer for `x IN ()` returning `'unsat'`. (Construct an `InNode` with `values: []`; pass it as the sole conjunct.)
- Unit test at the checker layer for `x IN (1, NULL)` resolving to `{1}` after NULL filtering, then proving `x = 2 AND x IN (1, NULL)` unsat (NULL entries don't rescue the contradiction — the in-place `intersectAllowed` already filters NULLs). This pins the existing-correct three-valued-logic behavior the review found uncovered.
- Plan-shape assertion: `Filter(_, lit-null)` folds to `EmptyRelationNode`, observable as `EMPTYRELATION` in the explain plan (today this already works via `ruleFilterFoldEmpty`; the test pins the cascade for the contradiction-rule path too).

## TODO

- Update `sat-checker.ts` `InNode` absorption: resolve `col` first, treat empty `values` as empty `intersectAllowed`.
- Update `rule-filter-contradiction.ts`: import / share `isLiteralFalsy` and short-circuit on the broader literal-falsy set.
- Add the three unit tests above. Verify with `yarn test --grep "Predicate contradiction|checkSatisfiability"`.
- `yarn build && yarn lint && yarn test` — full suite clean.
