description: Added distinct PlanNodeType.FunctionReference for FunctionReferenceNode
files:
  packages/quereus/src/planner/nodes/plan-node-type.ts
  packages/quereus/src/planner/nodes/reference.ts
----

## What was done

`FunctionReferenceNode` (scalar function reference) and `TableFunctionReferenceNode` (table-valued function reference) previously shared `PlanNodeType.TableFunctionReference`. A new `PlanNodeType.FunctionReference` enum value was added and assigned to `FunctionReferenceNode.nodeType`, giving each node class a distinct type discriminator.

## Key files

- `packages/quereus/src/planner/nodes/plan-node-type.ts` — added `FunctionReference = 'FunctionReference'` (line 72)
- `packages/quereus/src/planner/nodes/reference.ts` — `FunctionReferenceNode.nodeType` now uses `PlanNodeType.FunctionReference` (line 296)

## Testing

- Build passes
- All 177 tests pass (1 pre-existing failure in `bigint-mixed-arithmetic.sqllogic` unrelated)
- Scalar function calls exercised through sqllogic tests (builtin functions, scalar CSE, function features) which go through the `FunctionReferenceNode` planner path
- No downstream dispatch on either enum value via switch/case — resolution uses `instanceof` checks, so change is safe

## Review notes

- No code dispatches on `PlanNodeType.TableFunctionReference` or `PlanNodeType.FunctionReference` via case statements
- Resolution in `resolve.ts` and `global.ts` uses `instanceof FunctionReferenceNode`, unaffected by the nodeType change
- No docs updates needed — internal enum, not user-facing API
