---
description: Review iterative (worklist) rewrite of `PassManager.traverseTopDown` / `traverseBottomUp` that removes the recursion-depth ceiling.
prereq:
files:
  - packages/quereus/src/planner/framework/pass.ts
  - packages/quereus/test/optimizer/pass-manager.spec.ts
---

## What changed

`PassManager.traverseTopDown` and `traverseBottomUp` are now iterative worklist
loops in `packages/quereus/src/planner/framework/pass.ts`. The recursive
implementations are gone; everything else in the file (`applyPassRules`,
`inheritVisitedRules`, `assertOptimizationDepth`, `executeStandardPass`,
`PassState`, `planInputDepth`) is byte-identical.

The new traversal uses two stacks plus a small frame ADT (`VisitFrame` /
`FinalizeFrame`) declared next to `PassState`:

- **Work stack** — frames to process. A `visit` frame schedules a fresh node;
  a `finalize` frame splices the node's now-resolved child results back in.
- **Result stack** — finished `PlanNode` instances. Because children are pushed
  onto the work stack in reverse, their finalized results land on the result
  stack in original left-to-right order, so a tail splice of length
  `originalChildren.length` rebuilds the child array in the correct order.

`finalizeNode` is the one shared helper. For top-down it's called with
`applyRulesAfter: null` (rules already fired on entry); for bottom-up it gets
`{ context, pass, state }` so rules fire after children resolve.

### Invariants preserved

The ticket called these out explicitly. Verified by inspection:

- **Cache key is the original node id.** `optimizedNodes.set(frame.node.id, ...)`
  in the visit-leaf branch and `optimizedNodes.set(frame.origNodeId, ...)` in
  `finalizeNode`. Top-down captures the pre-rule id before calling
  `applyPassRules`; bottom-up's `origNodeId` is the same as `currentNode.id`
  since rules haven't fired yet at frame-creation time.
- **Cache hits short-circuit.** Both traversals check
  `context.optimizedNodes.get(frame.node.id)` at the top of every visit frame,
  before depth-assert or rule application.
- **`assertOptimizationDepth` fires at the same logical point** — on first
  entering a node, before any work, and only after the cache miss.
- **`withChildren` only when something actually changed.** The new code uses an
  explicit early-exit loop instead of `Array.some`, but the semantics are
  identical: any single `!==` triggers the rebuild; otherwise the original
  parent identity is preserved.
- **Top-down rule timing.** Rules apply to the parent before descending; the
  post-rule node's children (not the original's) are what gets walked.
- **`applyPassRules`, `inheritVisitedRules`, the rule-fired counter** are all
  unchanged.

### One implementation note worth flagging

`finalizeNode` uses `resultStack.splice(resultStack.length - n, n)`, which
mutates the stack in place and returns the removed slice in order. Equivalent
to the ticket's `popN`, but Array.splice is what was idiomatic to reach for.
The reviewer should sanity-check that this yields child results in original
order (it does, per the reverse-push scheme above), but if you prefer `pop`-in-
a-loop for clarity that's a defensible reshuffle.

## Tests added

Two new tests in `packages/quereus/test/optimizer/pass-manager.spec.ts`:

1. **`does not stack-overflow on deep plans (50,000-deep chain, both orders)`**
   builds a 50,000-deep linear `TestNode` chain and runs a no-op pass under
   both `TraversalOrder.TopDown` and `TraversalOrder.BottomUp` with tuning
   `{ maxOptimizationDepth: 100, optimizationDepthHeadroom: 100_000 }`. Asserts
   no throw and that the returned root identity equals the input (no rules
   fired). Completes in ~50ms on this machine. The recursive implementation
   would `RangeError` here.

2. **`preserves child ordering and rule semantics across a fan-out tree`** —
   sanity check for ordering. Builds a depth-3 binary `Filter` tree (15
   distinct nodes), runs a top-down `Filter→Project` pass followed by a
   bottom-up `leaf-Project→SingleRow` pass. Asserts 8 `SingleRow` leaves and 7
   internal `Project` nodes after both passes. The asymmetry catches an
   off-by-one or reverse-order bug in `finalizeNode`'s result-stack splice.

## Known gaps / honest framing

- **`ConstantRow` was specified in the ticket but doesn't exist** in
  `PlanNodeType`. Switched to `SingleRow`, which is the codebase's actual
  "zero-children produces one row" leaf type and serves the same role for the
  test. Worth a glance to confirm the substitution is fine.
- **The "cache hits observed for shared subtrees" sanity-test sub-goal from
  the ticket is not explicitly asserted.** The fan-out tree as built has 15
  distinct node instances (no DAG-style sharing), so within-pass cache hits
  don't fire on it. The primary stated goal — "catch obvious off-by-one in
  result-stack ordering" — is covered by the structural assertions
  (8 leaves + 7 internal Projects in the expected positions). If the reviewer
  wants explicit DAG-sharing coverage, a follow-up that builds a parent with
  two children both referencing the same leaf subtree would do it.
- **Lint output is empty** (eslint exits 0 silently). Test suite is fully
  green: 3174 passing. The pass-manager spec block specifically: 17 passing,
  6 in the ticket's `describe('PassManager')`.

## Validation

- `yarn workspace @quereus/quereus run test` → 3174 passing, 48s.
- `yarn workspace @quereus/quereus run lint` → exit 0, clean.
- 50,000-deep chain test: 51ms, no `RangeError`, both traversal orders.
- Existing pass-manager spec (cycle termination, depth-budget enforcement,
  input-scaled depth, maxRulesFired) all still green.

## Suggested review focus

- Confirm `finalizeNode`'s tail-splice ordering matches the recursive
  `children.map(...)` ordering (the reverse-push invariant).
- Confirm the cache-key choice in top-down (`frame.node.id`, not
  `postRule.id`) still matches what downstream code expects on cache hits.
- Decide whether the `ConstantRow → SingleRow` substitution in the sanity
  test is the right call or if a different leaf node would be more honest.
