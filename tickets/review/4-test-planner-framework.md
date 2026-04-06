description: Tests for planner framework — pass manager, rule registry, characteristics, and physical-utils
dependencies: none
files:
  - packages/quereus/test/planner/framework.spec.ts (new — 81 tests)
  - packages/quereus/src/planner/framework/pass.ts
  - packages/quereus/src/planner/framework/registry.ts
  - packages/quereus/src/planner/framework/characteristics.ts
  - packages/quereus/src/planner/framework/physical-utils.ts
  - packages/quereus/src/planner/framework/trace.ts
----

## What was built

81 unit tests in `packages/quereus/test/planner/framework.spec.ts` covering the planner framework layer using lightweight mock PlanNodes (no SQL parsing needed).

### PassManager (11 tests)
- Pass ordering (0→10→20→40)
- Convergence: rule that always matches terminates via visited-rules tracking
- disabledRules respected (skipped in applyPassRules)
- Max depth enforcement with helpful error message
- Node caching within a pass (shared child not re-optimized)
- Replacement inherits visited-rule state from original node
- Disabled pass skipped entirely
- executeUpTo stops at specified pass
- Top-down traversal order (parent before children)
- Bottom-up traversal order (children before parent)
- optimizedNodes cache cleared between passes

### RuleRegistry (3 tests)
- markRuleApplied / hasRuleBeenApplied round-trip
- Per-node isolation (different node IDs independent)
- Multiple rules on same node tracked independently

### PlanNodeCharacteristics (20 tests)
- hasSideEffects, isReadOnly, isDeterministic (true/false/default)
- estimatesRows (with value / default 1000)
- isExpensive threshold (>10K)
- isRelational, isScalar, isVoid type guards
- hasUniqueKeys, getUniqueKeys
- hasOrderedOutput
- isFunctional (deterministic + readonly)

### CapabilityDetectors (9 tests)
- canPushDownPredicate, isTableAccess, isSortable, isJoin, isCached
- isColumnReference (positive + relational rejection)
- isWindowFunction (positive + non-window rejection)

### CapabilityRegistry (3 tests)
- register + hasCapability round-trip
- getCapable filters correctly
- unregister removes capability

### Physical-utils (20 tests)
- extractOrderingFromSortKeys: column refs, non-refs, missing columns
- mergeOrderings: no parent, no child, prefix match, incompatible, too few columns
- orderingsEqual: equal, different length, different content, both undefined, one undefined, same ref
- orderingsCompatible: no requirements, no provider, prefix, exact, too few
- projectUniqueKeys: through mapping, unmapped dropped, all unmapped
- projectOrdering: through mapping, removed column, empty input
- uniqueKeysImplyDistinct: subset, non-subset, any-key, empty

### Trace hooks (5 tests)
- DebugTraceHook all methods callable without error
- PerformanceTraceHook records timings
- CompositeTraceHook dispatches to all children
- Hook error propagation
- setTraceHook / getCurrentTraceHook round-trip

## Testing notes

- All 81 new tests pass
- Full suite: 1344 passing, 2 pending (pre-existing)
- Tests use mock PlanNodes — no DB/parser dependency, fast execution (~16ms)
- Run: `node test-runner.mjs -- test/planner/framework.spec.ts`
