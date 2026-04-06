description: Tests for planner framework — pass manager, rule registry, characteristics, and physical-utils
dependencies: none
files:
  - packages/quereus/src/planner/framework/pass.ts
  - packages/quereus/src/planner/framework/registry.ts
  - packages/quereus/src/planner/framework/characteristics.ts
  - packages/quereus/src/planner/framework/physical-utils.ts
  - packages/quereus/src/planner/framework/context.ts
  - packages/quereus/src/planner/framework/trace.ts
  - packages/quereus/test/planner/framework.spec.ts (new)
----

## Motivation

`planner/framework/` has 72% line coverage but only 41% function coverage. This is the rule-application infrastructure the optimizer sits on — untested paths here can cause silent misoptimization or hangs.

## What to test

### PassManager (pass.ts)

- **Pass ordering**: passes execute in declared order (0→10→20→30→40)
- **Rule application terminates**: register a rule that always matches — verify the pass converges (max iterations) and doesn't hang
- **disabledRules respected**: disable a rule by ID, verify it's skipped in both `applyPassRules` and `applyRules` codepaths
- **Max depth enforcement**: trigger deep recursive optimization, verify error thrown with useful message
- **Node caching**: apply same node twice in same pass — verify the cached result is reused (not re-optimized)
- **Node replacement inheritance**: when a rule replaces a node, verify the replacement inherits rule tracking state

### RuleRegistry (registry.ts)

- **Registration and retrieval**: register a rule, retrieve by node type
- **Priority ordering**: register rules with different priorities, verify execution order
- **Duplicate rule IDs**: register same ID twice — verify behavior (error or last-wins)
- **Node type filtering**: register rules for different node types, verify only matching rules apply
- **visitedRules prevents re-application**: apply a rule, verify it's not re-applied to the same node ID on next pass

### PlanNodeCharacteristics (characteristics.ts)

- **hasSideEffects**: INSERT/UPDATE/DELETE nodes → true; SELECT → false
- **isReadOnly**: SELECT → true; DML → false
- **isDeterministic**: literal expressions → true; random() → false
- **estimatesRows**: node with estimatedRows set → returns the estimate
- **isExpensive**: node with >10K estimated rows → true; <10K → false
- **Capability detection**: verify each CapabilityDetector type guard against matching and non-matching nodes

### Physical property utilities (physical-utils.ts)

- **extractOrderingFromSortKeys**: simple column refs → ordering; complex expressions → undefined
- **mergeOrderings**: compatible orderings → merged; incompatible → null
- **orderingsEqual / orderingsCompatible**: exact match vs prefix match
- **projectUniqueKeys**: project keys through a mapping — verify unmapped keys are dropped
- **projectOrdering**: project ordering through column mapping
- **uniqueKeysImplyDistinct**: unique keys covering all output columns → true

### Trace hooks (trace.ts)

- **DebugTraceHook logs events**: mock debug channel, verify rule/phase events logged
- **PerformanceTraceHook records timings**: run a rule, verify timing recorded and non-negative
- **CompositeTraceHook dispatches to all children**: two mock hooks, verify both receive events
- **Hook error doesn't crash optimization**: hook that throws — verify optimization still completes

## Approach

Build minimal plan nodes and mock contexts directly — don't go through SQL. This keeps tests fast and isolated from parser/planner changes.
