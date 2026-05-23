description: Plan validator's attribute-uniqueness check rejects attribute-preserving N-ary parents (JoinNode, SetOperationNode, EagerPrefetchNode, AsyncGatherNode) by default. Either special-case these node families, change the default, or document the carve-out.
files: packages/quereus/src/planner/validation/plan-validator.ts, packages/quereus/test/planner/validation.spec.ts, packages/quereus/src/planner/nodes/set-operation-node.ts, packages/quereus/src/planner/nodes/join-node.ts, packages/quereus/src/planner/nodes/eager-prefetch-node.ts, packages/quereus/src/planner/nodes/async-gather-node.ts
----

## Background

`validatePhysicalTree(node)` runs a tree walk and registers every attribute ID it encounters; duplicates trigger `Duplicate attribute ID <n> found at <path> (previously seen at <other-path>)`. Several physical node families intentionally re-publish their children's attribute IDs verbatim so downstream `ORDER BY` and column references continue to resolve against the same IDs:

- `SetOperationNode` returns `left.getAttributes()` directly from `buildAttributes()`.
- `JoinNode` (inner/cross/right) concatenates left and right attributes verbatim into its own attribute list when `preserveAttributeIds` is not used by a downstream optimizer rule.
- `EagerPrefetchNode` passes the source's attribute list through unchanged (it is row-pass-through).
- `AsyncGatherNode` (added by ticket 5): unionAll mirrors `children[0]`; crossProduct concatenates verbatim.

For every one of these, `validatePhysicalTree` with default `{ validateAttributes: true }` throws because both the parent and the child carry the same attribute IDs.

In production the bite is silent: the `tuning.debug.validatePlan` knob defaults off, so the optimizer never runs `validatePhysicalTree` on real plans. The mismatch only surfaces when a test (or a manually-enabled debug flag) tries to validate one of these subtrees with default options.

## Why it's pre-existing and not a regression of 5

Ticket 5 (AsyncGatherNode) introduces *another* node in this family but does not change the validator behavior or any existing node's attribute model — the issue exists for `JoinNode`/`SetOperationNode`/`EagerPrefetchNode` on `main` today. The ticket 5 spec compensates by passing `{ validateAttributes: false }` for its one explicit validator test; documented as a known carve-out.

## What needs to happen

Pick one of the following (or document why this is intended behavior):

1. **Validator carve-out for attribute-preserving parents.** Add a per-node-type flag (e.g. an interface method `preservesChildAttributeIds(): boolean`, or an explicit allowlist in `plan-validator.ts`) that suppresses the duplicate-ID check when the duplicate is between a parent and one of its own children (not across siblings). The check should still fire when two unrelated subtrees collide on an ID.

2. **Change the default.** Flip `validateAttributes` to `false` by default and require opt-in for trees known not to have attribute-preserving parents. This is the simplest fix but weakens the default validation.

3. **Always allocate fresh attribute IDs at re-publishing parents.** This is the cleanest model, but it breaks the existing `ORDER BY` resolution contract that `SetOperationNode.buildAttributes` is explicitly designed around (the same convention the new `AsyncGatherNode(unionAll)` mirrors). Likely not feasible without a broader column-tracking refactor.

Option 1 is the most surgical. The flag is read-only metadata on each node class; the validator decides per-edge.

## Acceptance criteria

- `validatePhysicalTree(node)` with default options succeeds on a physical plan that contains `SetOperationNode`, `JoinNode` (inner/cross/right with verbatim attribute concatenation), `EagerPrefetchNode`, and `AsyncGatherNode`.
- The duplicate-ID check still catches genuine bugs: two unrelated subtrees that happen to emit the same ID still throw. Add a test covering this distinction.
- `AsyncGatherNode`'s validator test in `packages/quereus/test/runtime/async-gather.spec.ts` can drop its `{ validateAttributes: false }` workaround and the test should still pass.
