---
description: Comprehensive review plan for optimizer subsystem (rules, framework, analysis)
dependencies: none
priority: 3
---

# Optimizer Subsystem Review

## Goal

Conduct an adversarial review of the query optimizer to identify correctness risks, missing tests, and high-leverage refactors. In particular, validate rule termination, physical property propagation, and attribute ID stability across transformations.

## Scope

- **Framework**: Pass manager, rule registry, optimization context (`src/planner/framework/`)
- **Rules**: All optimization rules (`src/planner/rules/`)
- **Analysis**: Constraint extraction, predicate normalization, binding collection (`src/planner/analysis/`)
- **Integration**: Planner-optimizer boundary (attribute ID preservation)

## Non-goals

- Runtime execution review (see `3-review-core-runtime.md`)
- Planner AST-to-plan conversion (see `3-review-core-planner.md`)
- Virtual table implementation (see `3-review-core-vtab.md`)

## Checklist

### Rule Application Correctness

- [ ] **Rule termination / convergence**: Validate that repeated application cannot cycle (including node type-changing rewrites). Inspect `packages/quereus/src/planner/framework/pass.ts` and `packages/quereus/src/planner/framework/registry.ts`. Add/extend tests that exercise known “A→B→A” patterns.
- [ ] **Visited tracking semantics**: Confirm what “visited” means (per-node, per-rule, per-pass) and whether it prevents re-firing loops without blocking legitimate follow-up optimizations.
- [ ] **Depth limiting**: Confirm recursion/iteration depth limits are correct and testable. Inspect `packages/quereus/src/planner/optimizer.ts` and add a regression test for deep nesting.

### Physical Property Propagation

- [ ] **Ordering analysis**: Confirm whether ordering analysis is implemented (or intentionally stubbed). If there are TODOs (e.g. in streaming aggregate rules), decide whether to implement now or track as a follow-up with a focused test.
- [ ] **Unique key propagation**: Audit that unique keys/keys-by attributes are preserved through projections and common rewrites. Verify `packages/quereus/src/planner/framework/physical-utils.ts` is used consistently.
- [ ] **Cost model sanity**: Validate that costs are internally consistent and useful for relative ranking (not necessarily “accurate”). Add a small benchmark/regression test to ensure costs move in the expected direction for obvious plan changes.

### Attribute ID Preservation

- [ ] **Attribute collection correctness**: Verify expression/constraint walkers do not miss bindings (especially nested expressions). Prefer shared utilities (e.g. `packages/quereus/src/planner/analysis/binding-collector.ts`) over ad-hoc walkers where practical.
- [ ] **Attribute ID uniqueness**: Confirm attribute combination/merging logic cannot silently create duplicate IDs or cross-wire IDs across different sources.
- [ ] **Transformation stability**: Audit common rewrite helpers (`withChildren()`, node constructors) to ensure attribute IDs are preserved unless intentionally remapped. Add at least one regression test that fails if IDs drift.

### Code Quality

- [ ] **DRY hotspots**: Identify the top 2–3 duplicated patterns (predicate normalization, constraint extraction, binding collection) and either consolidate or document why they must remain separate.
- [ ] **Large functions**: Flag the biggest readability/maintainability offenders and propose a decomposition plan (don’t refactor “just because”; prioritize things that reduce bug surface area).
- [ ] **Constraint extraction complexity**: Review `packages/quereus/src/planner/analysis/constraint-extractor.ts` for correctness and maintainability. If it’s becoming a “god function”, decide on an incremental decomposition strategy and capture it as follow-up work.

### Framework Tests

- [ ] **Pass manager tests**: Cover pass execution order, traversal order (top-down vs bottom-up), and termination behavior.
- [ ] **Rule registry tests**: Cover rule priority ordering, visited tracking, and duplicate registration handling.
- [ ] **Context tests**: Cover context cloning/copying, depth limiting, and any node caching semantics.

### Rule Tests

- [ ] **Rule coverage**: Ensure high-risk rules have direct unit tests (predicate pushdown, join reordering, aggregate/window-related rules, CTE/materialization decisions).
- [ ] **Analysis module tests**: Add focused tests for `constraint-extractor`, `predicate-normalizer`, `binding-collector`, and `const-evaluator`.

## Deliverables

1. **Findings captured**: Concrete list of correctness risks and missing test cases
2. **Follow-up issues/PRs**: A small set of prioritized fixes/refactors (only if they pay down real risk)
3. **Tests added**: Regression tests for termination, attribute ID stability, and at least one physical-property case
4. **Docs updated**: Update `docs/optimizer.md` if it diverges from implementation (passes, registration, invariants)

## Test Plan

### Unit tests

- Framework: pass execution, registry semantics, context behavior
- Rules: high-risk rules get direct tests with at least one edge case each
- Analysis: constraint extraction, predicate normalization, binding collection

### Integration tests

- Attribute ID stability across planner→optimizer boundary
- Physical property propagation across a small chain of rewrites
- Termination for queries that trigger multiple rule applications

### SQLLogic/regression tests

- Add/extend sqllogic coverage for cases known to be sensitive to optimizer rewrites (predicate pushdown, join ordering, aggregates, CTE decisions).

## Acceptance Criteria

- No known non-terminating optimization cycles (with at least one regression test covering the previously risky pattern)
- Attribute IDs remain stable across optimizer transformations (with at least one regression test)
- Physical properties (ordering, keys) are either correctly propagated or explicitly documented as not yet implemented
- High-risk rules and analysis utilities have focused tests
- Documentation reflects current optimizer architecture and known limitations

## Notes/Links

- Related: `3-review-core-planner.md` (planner-optimizer integration)
- Related: `3-review-core-runtime.md` (optimizer-runtime integration)
- Framework docs: `docs/optimizer.md`
- Rule conventions: `docs/optimizer-conventions.md`