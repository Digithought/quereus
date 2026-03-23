description: Added distinct PlanNodeType.FunctionReference for FunctionReferenceNode
dependencies: none
files:
  packages/quereus/src/planner/nodes/plan-node-type.ts
  packages/quereus/src/planner/nodes/reference.ts
----

## Summary

`FunctionReferenceNode` (scalar function reference) and `TableFunctionReferenceNode` (table-valued function reference) previously shared `PlanNodeType.TableFunctionReference`, making them indistinguishable by any code dispatching on `nodeType`.

## Changes

1. Added `FunctionReference = 'FunctionReference'` to `PlanNodeType` enum (line 72 in `plan-node-type.ts`).
2. Updated `FunctionReferenceNode.nodeType` to `PlanNodeType.FunctionReference` (line 296 in `reference.ts`).

No downstream code was affected — nothing dispatched on `PlanNodeType.TableFunctionReference` expecting to match `FunctionReferenceNode`.

## Testing / Validation

- Build passes
- All 177 tests pass (1 pre-existing failure in `bigint-mixed-arithmetic.sqllogic` unrelated)
- Key use cases to verify during review:
  - Scalar function references resolve with `PlanNodeType.FunctionReference`
  - Table-valued function references still resolve with `PlanNodeType.TableFunctionReference`
  - Any switch/dispatch on `PlanNodeType` that handles function references still works correctly
