---
description: Convert `PassManager.traverseTopDown` / `traverseBottomUp` to iterative (worklist) traversal so plans deeper than V8's JS stack don't crash the engine.
prereq:
files:
  - packages/quereus/src/planner/framework/pass.ts
  - packages/quereus/test/optimizer/pass-manager.spec.ts
---

## Background

`framework/pass.ts` is currently recursive in both `traverseTopDown` and `traverseBottomUp`. Historically the hard cap of `maxOptimizationDepth = 50` made the recursion safe. The recent input-scaled-budget change (ticket `optimizer-max-depth-wide-where`) lets the per-pass budget grow to `max(maxOptimizationDepth, planInputDepth + optimizationDepthHeadroom)`, so a 10,000-deep input plan now happily descends 10,000 recursive JS frames — past V8's default ~10–20k limit on pathological inputs.

`planInputDepth` (pass.ts:167–179) is already iterative; we model the new traversal after that shape.

## Algorithm

Both traversals use:
- a **work stack** of frames
- a **result stack** that child finalization pushes onto and parent finalization pops from

The recursive bodies do three things that the iterative version must preserve:
1. depth-budget check at each entry (`assertOptimizationDepth`)
2. `context.optimizedNodes` memoization (lookup + set keyed on the *original* node id)
3. `applyPassRules(currentNode, …)` — which may return a wholly new node whose children differ from the original

### Frames

Two frame kinds:

```ts
type Frame =
  | { kind: 'visit'; node: PlanNode; depth: number }
  | {
      kind: 'finalize';
      origNodeId: string;            // for cache key — always the ORIGINAL node's id
      currentNode: PlanNode;          // pre-children-resolved parent (post-rule for top-down, original for bottom-up)
      originalChildren: readonly PlanNode[]; // to detect childrenChanged
      depth: number;
    };
```

### Bottom-up (mirrors current recursive shape)

```
push { kind: 'visit', node: plan, depth: 0 }
while stack not empty:
  f = stack.pop()
  if f.kind === 'visit':
    if cached = optimizedNodes.get(f.node.id): resultStack.push(cached); continue
    assertOptimizationDepth(state, f.depth)
    children = f.node.getChildren()
    if children.length === 0:
      result = applyPassRules(f.node, ctx, pass, state)
      optimizedNodes.set(f.node.id, result)
      resultStack.push(result)
    else:
      // schedule finalize, then push children in reverse so leftmost is popped first
      stack.push({ kind: 'finalize', origNodeId: f.node.id, currentNode: f.node,
                   originalChildren: children, depth: f.depth })
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push({ kind: 'visit', node: children[i], depth: f.depth + 1 })
      }
  else: // finalize
    newChildren = popN(resultStack, f.originalChildren.length) // pop in order, no reversing needed since pushed reverse
    let node = f.currentNode
    if any newChildren[i] !== f.originalChildren[i]: node = node.withChildren(newChildren)
    result = applyPassRules(node, ctx, pass, state)
    optimizedNodes.set(f.origNodeId, result)
    resultStack.push(result)
return resultStack[0]
```

Note on pop order: because children are pushed in reverse, they finalize and push their results onto `resultStack` left-to-right. So a single `slice(-n)` (or `splice(-n, n)`) on `resultStack` yields them in the *original* child order.

### Top-down

Rules apply to the parent **before** descending — and the post-rule parent's children are what gets walked. So `currentNode` and `originalChildren` in the finalize frame are derived from the *post-rule* node, not from `f.node`.

```
visit: 
  cache check on f.node.id
  assertDepth
  postRule = applyPassRules(f.node, ctx, pass, state)
  children = postRule.getChildren()
  if children.length === 0:
    optimizedNodes.set(f.node.id, postRule); resultStack.push(postRule)
  else:
    stack.push({ kind: 'finalize', origNodeId: f.node.id, currentNode: postRule,
                 originalChildren: children, depth: f.depth })
    for (let i = children.length - 1; i >= 0; i--):
      stack.push({ kind: 'visit', node: children[i], depth: f.depth + 1 })

finalize: same as bottom-up but WITHOUT the trailing applyPassRules step — rules already fired on entry.
```

### Invariants to preserve

- `assertOptimizationDepth` fires at the same logical points (when first entering a node, before any work).
- The cache key is the *original* `node.id`, not the post-rule id. The existing recursive code uses `node.id` in the set even when `result` differs — keep that behavior.
- Cache hits short-circuit and never apply rules / never descend. Match exactly.
- `applyPassRules`, `inheritVisitedRules`, rule-fired counter all stay byte-for-byte; only the traversal scaffolding changes.
- `withChildren` is only called when at least one child reference actually changed (preserves identity equality for unchanged subtrees, which downstream code relies on).

## TODO

- Replace `traverseTopDown` body with the iterative worklist above; remove the `depth` recursion parameter or keep it as a starting `0` for the loop's first frame.
- Replace `traverseBottomUp` body similarly.
- Keep `assertOptimizationDepth`, `applyPassRules`, `inheritVisitedRules`, the `PassState` struct, and `executeStandardPass` unchanged.
- Confirm `planInputDepth` is left as-is (already iterative).
- Add a test in `packages/quereus/test/optimizer/pass-manager.spec.ts`:
  - `does not stack-overflow on deep plans`: build a chain of 50,000 synthetic test nodes (same `TestNode` shape already used in that file — `getChildren()` returns `[next]`, `withChildren` returns self). Run a no-op pass (no matching rules) in both `TraversalOrder.TopDown` and `TraversalOrder.BottomUp` with tuning `{ maxOptimizationDepth: 100, optimizationDepthHeadroom: 100_000 }`. Must complete without `RangeError`. Assert the returned node identity equals the root (unchanged because no rules fired).
  - Sanity test: a small fan-out tree (depth 3, 2 children per node) under a top-down rule that rewrites `Filter→Project` and then a bottom-up rule that rewrites `Project→ConstantRow` — assert final root type matches expectation and that `optimizedNodes` cache hits are observed for shared subtrees. (Goal: catch obvious off-by-one in result-stack ordering.)
- Run `yarn workspace @quereus/quereus run test 2>&1 | tee /tmp/quereus-test.log` and ensure all existing pass-manager / framework / planner tests still pass.
- Run `yarn workspace @quereus/quereus run lint 2>&1 | tee /tmp/quereus-lint.log`.

## Validation

- `yarn test` clean.
- New 50k-depth test passes for both traversal orders.
- No `RangeError: Maximum call stack size exceeded` anywhere in test output.
- Behavior on small inputs (existing pass-manager.spec.ts cycle/termination tests) unchanged.
