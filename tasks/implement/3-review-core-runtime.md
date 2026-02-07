---
description: Comprehensive review of runtime subsystem (emitters, scheduler, execution)
dependencies: none
priority: 3
---

# Runtime Subsystem Review

## Goal

Conduct adversarial review of the runtime execution engine to ensure correct instruction execution, proper context management, and robust error handling. Verify emission correctness and scheduler reliability.

## Scope

- **Scheduler**: Instruction execution, dependency resolution (`src/runtime/scheduler.ts`)
- **Emitters**: Plan node → Instruction conversion (`src/runtime/emit/`)
- **Context**: Row context management (`src/runtime/context-helpers.ts`, `emission-context.ts`)
- **Infrastructure**: Deferred constraints, caching, async utilities (`src/runtime/`)

## Non-goals

- Optimizer plan generation (see `3-review-core-optimizer.md`)
- Planner AST conversion (see `3-review-core-planner.md`)
- Virtual table implementation (see `3-review-core-vtab.md`)

## Checklist

### Scheduler behavior (correctness + maintainability)

- [ ] **Execution mode consistency**: Compare optimized/tracing/metrics modes in `packages/quereus/src/runtime/scheduler.ts` and ensure they are behaviorally equivalent (modulo observability). Add a regression test that runs the same query in each mode and compares results + side effects.
- [ ] **Context lifecycle**: Verify context push/pop and row-slot lifetimes are balanced even under errors/cancellation. If “leak detection” exists, decide whether it should fail tests (at least in CI/strict mode).
- [ ] **Async error propagation**: Ensure `Promise.all`/async-generator paths don’t swallow errors and always clean up resources.

### Emitters (semantic correctness)

- [ ] **Aggregate emitter**: Review `packages/quereus/src/runtime/emit/aggregate.ts` for correctness (grouping keys, distinct aggregates, null semantics, accumulator lifecycle). Add at least one regression test for a tricky aggregate case.
- [ ] **Window emitter**: Review `packages/quereus/src/runtime/emit/window.ts` for frame-bound correctness. If TODOs exist, capture them as follow-up tasks and add tests that demonstrate current gaps.
- [ ] **Join emitter coverage**: Confirm which join types are supported in `packages/quereus/src/runtime/emit/join.ts` (inner/left/right/full) and add tests matching the intended surface area. If right/full are not implemented, track explicitly as follow-up work.
- [ ] **Common emitter utilities**: Identify duplicated patterns (accumulator init/finalize, context wiring) and decide whether a small shared helper would reduce bug surface area.

### Context Management

- [ ] **Cleanup discipline**: Ensure emitters consistently clean up row context, even on early-return and errors. Prefer the existing helper patterns where they exist; avoid bespoke manual cleanup.
- [ ] **Validation hooks**: If possible, add inexpensive assertions for push/pop balance in `packages/quereus/src/runtime/context-helpers.ts` (at least in debug/strict mode).
- [ ] **Resolution order**: Confirm attribute resolution order (newest → oldest) is correct and covered by a focused test.

### Error Handling

- [ ] **Preserve original cause**: Ensure errors keep the original stack/cause where possible (e.g. runtime scanning and scheduler wrappers). Avoid “swallowing” exceptions; either expected errors aren’t exceptions, or they must propagate.
- [ ] **Constraint error context**: Ensure deferred constraint failures include actionable context (which constraint, which table/row keys if safe) without leaking sensitive payloads.
- [ ] **Async generators**: Ensure errors in async generator emitters propagate to callers and still trigger cleanup.

### Known/likely defect hunting

- [ ] **Deferred constraint association**: Validate how deferred constraints map back to the correct connection/table and add a regression test for multi-table / same-name edge cases.
- [ ] **Window frame offsets**: Search for hard-coded offsets or incomplete frame evaluation. If found, add tests and file follow-up work.

### Test Coverage

- [ ] **Scheduler tests**: Add/extend tests under `packages/quereus/test/` to cover empty instruction lists, dependency chains, async rejection, and context cleanup.
- [ ] **Emitter tests**: Add focused tests for aggregate/window/join emitters (basic behavior, tricky edge cases, error paths).
- [ ] **Context tests**: Add tests for push/pop balance, resolution order, and cleanup under `packages/quereus/test/`.
- [ ] **Deferred constraints tests**: Add tests covering layer rollback/release, evaluation order, and connection mapping under `packages/quereus/test/`.

## Deliverables

1. **Refactored scheduler**: Single execution loop with strategy hooks, reduced from 6 methods to 2
2. **Decomposed emitters**: Aggregate and window emitters split into testable functions
3. **Fixed bugs**: Right/full outer join, window frame offsets, connection matching
4. **Test suites**: Scheduler, emitter, context, deferred constraint tests
5. **Documentation**: Update `docs/runtime.md` with execution modes, error handling, emitter patterns

## Test Plan

### Unit Tests

- **Scheduler**: Execution modes, dependency resolution, error handling, context leak detection
- **Emitters**: Each emitter tested for basic execution, errors, context, edge cases
- **Context helpers**: Push/pop balance, attribute resolution, nested contexts
- **Deferred constraints**: Layer management, evaluation order, error handling

### Integration Tests

- **End-to-end execution**: Full query execution with all emitter types
- **Error propagation**: Errors from emitters propagate correctly to scheduler
- **Context leak detection**: Real queries don't leak context (tested with 100+ queries)

### Logic Tests

- Add SQL logic tests for runtime correctness (`test/logic/13-runtime-*.sqllogic`):
  - All join types
  - Window function frame specifications
  - Aggregate edge cases
  - Error handling scenarios

## Acceptance Criteria

- Execution modes are behaviorally equivalent (with at least one regression test)
- No known context leaks in emitters under success or error paths (with a regression test)
- Join/window/aggregate semantics match intended feature set (with focused tests for tricky cases)
- Error context is preserved and actionable without swallowing exceptions

## Notes/Links

- Related: `3-review-core-optimizer.md` (optimizer-runtime integration)
- Related: `3-review-core-planner.md` (planner-runtime integration)
- Runtime docs: `docs/runtime.md`