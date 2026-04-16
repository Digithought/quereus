<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-04-15T23:31:06.445Z (agent: claude)
  Log file: C:\projects\quereus\tickets\.logs\4-test-constraint-extractor-mutation-kills.implement.2026-04-15T23-31-06-444Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
---
description: Kill surviving Stryker mutants in src/planner/analysis/constraint-extractor.ts — baseline 47.97% with ~176 survivors, the largest gap in planner/analysis per the mutation testing session.
dependencies: Stryker infrastructure (already configured in stryker.config.mjs, `yarn mutation:subsystem analysis`)
files:
  packages/quereus/src/planner/analysis/constraint-extractor.ts
  packages/quereus/test/planner/constraint-extractor.spec.ts
  packages/quereus/test/logic/106-constraint-extractor-mutation-kills.sqllogic
  packages/quereus/docs/zero-bug-plan.md
---

## Context

`constraint-extractor.ts` translates WHERE-clause scalar expressions into `PredicateConstraint`/`RangeSpec` values that drive vtab access planning. It is ~1200 lines and the largest unit in `planner/analysis/`. The mutation session (`docs/zero-bug-plan.md` §6) logged a 47.97% mutation score — the lowest of the targeted files — and flagged it as the next priority. Every surviving mutant here represents a predicate that may be pushed down incorrectly (wrong operator, wrong bound, wrong column, wrong negation), which silently produces wrong query results.

## Scope

Kill mutants across these entry points and their helpers:

| Function | Line | What it does |
|---|---|---|
| `extractConstraints` | 84 | Top-level entry — walks AND/OR tree |
| `extractFromExpression` | 182 | Recursive descent on boolean expressions |
| `extractBinaryConstraint` | 301 | `col op literal` → `PredicateConstraint` |
| `extractBetweenConstraints` | 394 | `col BETWEEN a AND b` → low/high bounds |
| `extractInConstraint` | 442 | `col IN (...)` → IN set |
| `extractNullConstraint` | 490 | `col IS NULL` / `IS NOT NULL` |
| `mapOperatorToConstraint` | 520 | String op → `ConstraintOp` enum |
| `flattenOrDisjuncts` | 539 | Flattens nested `OR` chains |
| `tryExtractOrBranches` | 563 | Per-branch OR analysis |
| `collapseBranchesToIn` | 626 | `a=1 OR a=2 OR a=3` → `a IN (1,2,3)` |
| `tryCollapseToOrRange` | 684 | `a<1 OR a>9` → range gaps |
| `flipOperator` | 820 | Swap sides: `1<a` → `a>1` |
| `extractConstraintsForTable` | 840 | Per-table slicing |
| `extractConstraintsAndResidualForTable` | 870 | Split supported vs residual |
| `extractCoveredKeysForTable` | 899 | Key-set extraction for joins/lookups |

## Test strategy

Two complementary test layers — both are required to kill operator/bound mutants densely:

**Unit tests** (`test/planner/constraint-extractor.spec.ts`, new): direct calls to `extractConstraints`/`extractConstraintsForTable` with hand-built scalar plan trees. Use the same helpers as `test/planner/predicate-normalizer.spec.ts` (which landed in the mutation session) for building ColumnReference/Literal nodes. Assert exact `ConstraintOp` values, exact bound literals, exact column indices, and exact residual shapes.

**SQL logic tests** (`test/logic/106-constraint-extractor-mutation-kills.sqllogic`, new): end-to-end queries that exercise each extraction path and assert both row correctness **and** plan shape (via `explain` + `plan like` pattern matching), so a mutant that corrupts the pushed-down predicate is caught by the wrong-row-count even if the plan-shape match still passes.

### Targeted mutant categories

Mutation operators Stryker applies here are primarily:
- **ConditionalExpression** — boundary flips (`<` → `<=`, `>` → `>=`, `===` → `!==`)
- **EqualityOperator** — `=` ↔ `!=`
- **LogicalOperator** — `&&` ↔ `||`
- **BlockStatement / BooleanLiteral** — return `true`/`false` stubs
- **StringLiteral** — operator name swaps in `mapOperatorToConstraint`
- **ArrayDeclaration** — empty-array returns

Each test case below is designed to fail if ≥1 of the above is applied to the corresponding branch:

- **Binary operators** — one row per `= != < <= > >= IS IS NOT`, both `col op lit` and `lit op col` (hits `flipOperator`), with NULL-literal variants
- **BETWEEN** — inclusive bounds, `NOT BETWEEN`, nested inside `AND` and `OR`
- **IN / NOT IN** — single-element, multi-element, empty-list (error), NULL-in-list, subquery-IN (should **not** extract)
- **IS NULL / IS NOT NULL** — on nullable and NOT NULL columns, inside NOT
- **OR → IN collapse** — `a=1 OR a=2 OR a=3`, mixed-type branches (should not collapse), non-matching columns (should not collapse), >constant threshold (should collapse), <threshold (should not)
- **OR → range collapse** — `a<1 OR a>9`, `a<=1 OR a>=9`, mismatched operators, different columns
- **AND decomposition** — deeply nested ANDs, redundant duplicate constraints
- **Per-table slicing** — two-table joins where one half of a predicate references each table; assert each table only receives its own constraints
- **Residual emission** — unsupported predicates (function calls, CASE, subqueries) land in residual, not constraints
- **Covered-key extraction** — composite keys, partial keys, reversed order

### Validation loop

```bash
cd packages/quereus
yarn test                                        # unit + logic
yarn mutation:subsystem analysis                 # re-score
```

Target: raise `constraint-extractor.ts` score from 47.97% to ≥75%. Document any equivalent mutants found in the commit message and in `docs/zero-bug-plan.md` §6 "Common equivalent mutant patterns".

## TODO

- [ ] Baseline-capture current `constraint-extractor.ts` mutation report (save surviving mutant list to scratch file)
- [ ] Create `test/planner/constraint-extractor.spec.ts` with helper for building `ScalarPlanNode` trees from raw literal/column metadata
- [ ] Unit-test each public export: `extractConstraints`, `extractConstraintsForTable`, `extractConstraintsAndResidualForTable`, `extractCoveredKeysForTable`
- [ ] Unit-test private helpers through their public-export surface — boundary values for every operator, both orderings
- [ ] Create `test/logic/106-constraint-extractor-mutation-kills.sqllogic` targeting OR-collapse, IN-expansion, BETWEEN, per-table slicing
- [ ] Re-run `yarn mutation:subsystem analysis` and record new score; iterate on surviving mutants until ≥75%
- [ ] Update `docs/zero-bug-plan.md` §6 table with new score
- [ ] Flag documented equivalent mutants (cosmetic debug strings, identity-check optimizations) rather than contorting tests around them
