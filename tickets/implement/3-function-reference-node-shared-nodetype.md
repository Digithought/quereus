description: Add distinct PlanNodeType.FunctionReference for FunctionReferenceNode
dependencies: none
files:
  packages/quereus/src/planner/nodes/plan-node-type.ts
  packages/quereus/src/planner/nodes/reference.ts
----

## Problem

`FunctionReferenceNode` (scalar function reference, generic `PlanNode`) and `TableFunctionReferenceNode` (table-valued function reference, `ZeroAryRelationalNode`) both used `PlanNodeType.TableFunctionReference`. This made them indistinguishable by any code dispatching on `nodeType`.

## Fix (already applied)

1. Added `FunctionReference = 'FunctionReference'` to `PlanNodeType` enum in `plan-node-type.ts` (line 72, scalar expression section).
2. Updated `FunctionReferenceNode.nodeType` to `PlanNodeType.FunctionReference` in `reference.ts` (line 296).

No other code referenced `PlanNodeType.TableFunctionReference` expecting to match `FunctionReferenceNode`, so no downstream changes needed.

## Verification

- Build passes
- All 177 tests pass (1 pre-existing failure in `emit-missing-types.spec.ts` unrelated to this change)

- [ ] Verify build passes
- [ ] Verify tests pass
