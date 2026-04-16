description: Review mutation-killing tests for constraint-extractor.ts — 210 unit tests + 60 sqllogic queries added, score raised from 47.97% to 68.86% (78.76% covered)
dependencies: none
files:
  packages/quereus/test/planner/constraint-extractor.spec.ts
  packages/quereus/test/logic/106-constraint-extractor-mutation-kills.sqllogic
  packages/quereus/src/planner/analysis/constraint-extractor.ts
---

## What was built

Two test layers targeting surviving Stryker mutants in `constraint-extractor.ts`:

**Unit tests** (`test/planner/constraint-extractor.spec.ts`, 210 tests, ~2555 lines):
Direct calls to `extractConstraints`, `computeCoveredKeysForConstraints`, and `createResidualFilter` with hand-built `ScalarPlanNode` trees. Covers every public export and exercises private helpers through their public surface. Key test categories:
- Binary operator mapping (all 8 operators + unsupported)
- `flipOperator` — all reversals including symmetric ops (LIKE, GLOB, MATCH)
- Literal value extraction (integer, string, null, 0, empty string)
- BETWEEN extraction + NOT BETWEEN residual + edge cases
- IN extraction (literal, mixed dynamic, subquery rejection, non-usable values)
- IS NULL / IS NOT NULL extraction
- AND decomposition (nested, partial extraction)
- OR -> IN collapse (same column, different columns, mixed IN+equality, parameter branches)
- OR -> OR_RANGE collapse (various bound combos, equality in ranges, multi-branch, different columns)
- Per-table constraint grouping (multi-table predicates)
- Residual predicate shape (0, 1, 2+ residuals)
- Covered keys (equality, single-value IN, composite keys, zero-length keys)
- Dynamic binding metadata (literal, parameter, correlated, expression, mixed)
- CastNode unwrapping (column, literal, parameter through cast)
- `usable` flag verification on BETWEEN, IS NULL, IS NOT NULL constraints
- Column index mapping edge cases (empty columnIndexMap)
- `createResidualFilter` stub behavior

**SQL logic tests** (`test/logic/106-constraint-extractor-mutation-kills.sqllogic`, ~60 queries):
End-to-end queries exercising every extraction path through the full SQL pipeline. Covers binary operators, flip patterns, BETWEEN, IN, IS NULL, AND/OR decomposition, OR collapse, range gaps, per-table joins, aggregate + constraint, CAST, LIKE, parameterized queries.

## Mutation score

- **Baseline**: 47.97% (from zero-bug-plan session)
- **After prior agent (165 unit tests + sqllogic)**: 66.15% (342/517 detected)
- **After this session (210 unit + sqllogic)**: **68.86%** (356/517 detected, 78.76% covered)

### Score ceiling analysis

The remaining undetected mutants fall into three categories:
1. **NoCoverage (65 mutants)**: In plan-level functions (`extractConstraintsForTable`, `extractConstraintsAndResidualForTable`, `analyzeRowSpecific`, `demoteForAggregate`, `demoteAllBeneath`, `collectRelationKeysBeneath`, `createTableInfosFromPlan`, `walkPlanForPredicates`) that require actual `RelationalPlanNode` trees to exercise. These are only reachable through the full optimizer pipeline.
2. **Equivalent mutants (~20)**: Mutations that don't change observable behavior:
   - L761/L769: `isAndExpression`/`isOrExpression` — nodeType check vs operator check (both equivalent for all valid AST nodes)
   - L142: `relationKey || relationName` — always matches on relationKey first since constraints target tables by relationKey
   - L120: residual array indexing — accessing `[0]` of empty array returns `undefined`, same as not setting the variable
   - L381, L387: Dead code paths in binding detection (unreachable after isDynamicValue check)
   - L530-531, L830-831: `mapOperatorToConstraint`/`flipOperator` cases for IN/NOT IN never reached through extractBinaryConstraint
3. **Survived (~20-30)**: In `collapseBranchesToIn` and `tryCollapseToOrRange` internal logic where BlockStatement mutations remove loop bodies but the outer structure still produces valid (empty) results

### Review checklist

- [ ] Verify all 322 tests pass: `yarn test`
- [ ] Check lint: `cd packages/quereus && npx eslint 'test/planner/constraint-extractor.spec.ts'`
- [ ] Run mutation score: `cd packages/quereus && npx stryker run stryker.config.mjs --mutate "src/planner/analysis/constraint-extractor.ts"`
- [ ] Verify test assertions match interface contracts (not implementation details)
- [ ] Spot-check that sqllogic expected results are correct
- [ ] Confirm no changes to production code (test-only ticket)
