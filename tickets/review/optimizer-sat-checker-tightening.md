---
description: Two narrow tightenings of predicate-contradiction analysis — (a) `x IN ()` now folds to `unsat` via the sat-checker, and (b) `rule-filter-contradiction` short-circuits on the broader `lit-null|false|0|0n` set instead of dispatching to the sat-checker. Includes three new tests.
prereq:
files:
  - packages/quereus/src/planner/analysis/sat-checker.ts
  - packages/quereus/src/planner/rules/predicate/rule-filter-contradiction.ts
  - packages/quereus/src/planner/rules/predicate/rule-empty-relation-folding.ts
  - packages/quereus/test/optimizer/predicate-contradiction.spec.ts
---

## Changes

### 1. `x IN ()` → `unsat` (sat-checker.ts)

`absorb` for `InNode`: resolve `col` *first*, then handle the empty `values` list by calling `intersectAllowed(getOrCreate(accs, col), [], col, cmp)`. The decision loop's `filtered.length === 0 → unsat` step now catches it.

- `(a + b) IN ()` — `columnOf` returns `undefined`, so we still bail to `markUnknownForColumns`. Safe.
- `x IN ()` with a resolvable column ref — empty `allowedValues` → unsat.

### 2. `Filter(_, lit-null)` guard (rule-filter-contradiction.ts)

Replaced the literal-`false`-only guard with a call to `isLiteralFalsy(node.predicate)`, which is the same helper `rule-empty-relation-folding.ts` already uses (covers `false | null | 0 | 0n`). Exported `isLiteralFalsy` from `rule-empty-relation-folding.ts` rather than duplicating it — both rules are tightly co-located in `rules/predicate/`.

This short-circuit prevents wasted dispatch to the sat-checker for predicates the sibling `ruleFilterFoldEmpty` will collapse anyway. The sat-checker would otherwise return `'sat'` for a bare `lit-null` (no column refs to mark), so this was wasted work, not a correctness issue.

### 3. Tests

Added three new tests in `test/optimizer/predicate-contradiction.spec.ts`:

- **`detects empty IN-list: x IN () → unsat`** — checker-layer unit test.
- **`NULL members do not rescue contradiction: x = 2 ∧ x IN (1, NULL) → unsat`** — pins existing-correct three-valued-logic behavior (NULL stripping in `intersectAllowed`). The review found this uncovered.
- **`WHERE NULL folds to empty (lit-null short-circuit)`** — end-to-end plan-shape assertion that `Filter(_, lit-null)` → `EmptyRelationNode` (today this already worked via `ruleFilterFoldEmpty`; the test pins the cascade for the contradiction-rule path now that it short-circuits earlier).

## Validation

- `yarn workspace @quereus/quereus build` — clean
- `yarn workspace @quereus/quereus run lint` — clean
- `yarn workspace @quereus/quereus run test --grep "Predicate contradiction|checkSatisfiability"` — 26 passing
- `yarn test` — full sweep clean for `@quereus/quereus`. Two failures in `packages/sample-plugins/test/plugins.spec.ts` (key_value_store DELETE/UPDATE) reproduce on `git stash` baseline — pre-existing and unrelated to predicate analysis.

## Use cases for testing

- `WHERE x IN ()` alone — should fold to `EMPTYRELATION`.
- `WHERE x IN (1, NULL) AND x = 2` — should fold to `EMPTYRELATION` (NULL stripping must not rescue the contradiction).
- `WHERE (a+b) IN ()` — must NOT fold; `a+b` isn't a resolvable column ref so we bail to `sawUnknown`. (No false unsat — preserved.)
- `WHERE NULL`, `WHERE 0`, `WHERE 0n`, `WHERE FALSE` — all four should fold to `EMPTYRELATION` via `ruleFilterFoldEmpty`. The contradiction rule now bails early on all of them.

## Known gaps / out-of-scope

- The parser typically rejects `x IN ()` syntactically, so the change in (1) primarily covers IN-lists synthesized programmatically by other planner code (and is now defensible if the parser is ever relaxed).
- No end-to-end SQL test for `x IN ()` because the parser rejects the literal text. The unit test at the checker layer is the right place for it.
- `Filter(_, lit-null)` folds via `ruleFilterFoldEmpty` regardless of the contradiction-rule change; the short-circuit is a perf/clarity tightening, not a correctness fix. Reviewers should verify the cascade ordering (both rules at priority 27, fixed-point per-node) still produces the same end state.

## TODO (none — work complete)
