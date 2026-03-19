description: ViewReferenceNode uses TableReference nodeType and defaults all column types to TEXT
dependencies: none
files:
  packages/quereus/src/planner/nodes/view-reference-node.ts
----
## Defect: wrong nodeType

`ViewReferenceNode` sets `nodeType = PlanNodeType.TableReference`, making it indistinguishable from actual table references at the plan level. If any optimizer rule or emitter dispatches on `PlanNodeType.TableReference`, it would incorrectly treat view references as table references.

## Smell: all columns default to TEXT_TYPE

`buildAttributes()` defaults every column's type to `TEXT_TYPE` with the comment "Default type, should be inferred". This means downstream type checks, coercions, and optimizer decisions for views see all columns as TEXT regardless of the actual underlying types.

## Smell: isReadOnly defaults to false

`buildType()` sets `isReadOnly: false` for the relation, but views are query substitutions and are typically read-only. This could allow the optimizer or planner to consider mutation paths that will fail at runtime.

## TODO

- Add a `PlanNodeType.ViewReference` entry (or confirm TableReference is intentional)
- Infer column types from the view's planned SELECT statement rather than defaulting to TEXT
- Set `isReadOnly: true` for view types (or derive from the underlying query)
