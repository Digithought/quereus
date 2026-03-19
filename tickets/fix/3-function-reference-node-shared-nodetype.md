description: FunctionReferenceNode and TableFunctionReferenceNode share the same PlanNodeType
dependencies: none
files:
  packages/quereus/src/planner/nodes/reference.ts
  packages/quereus/src/planner/nodes/plan-node-type.ts
----
`FunctionReferenceNode` (line 295) and `TableFunctionReferenceNode` (line 118) in `reference.ts` both use `PlanNodeType.TableFunctionReference` as their `nodeType`. These are distinct node classes:

- `TableFunctionReferenceNode`: a `ZeroAryRelationalNode` representing a table-valued function reference
- `FunctionReferenceNode`: a generic `PlanNode` (neither relational nor scalar) representing a scalar function reference

Sharing a nodeType means any code dispatching on `nodeType` (optimizer rules, plan visitors, formatters) cannot distinguish them. Currently both are consumed during the planning/building phase and don't reach the emitter, but this is fragile.

**Fix**: Add a `FunctionReference` entry to `PlanNodeType` enum and use it in `FunctionReferenceNode`.

- [ ] Add `FunctionReference = 'FunctionReference'` to plan-node-type.ts (scalar expression section)
- [ ] Update `FunctionReferenceNode.nodeType` to use the new enum value
- [ ] Verify no code path relies on the shared value
