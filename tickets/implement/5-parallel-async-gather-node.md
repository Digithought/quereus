description: AsyncGatherNode physical node + emitter. N independent (uncorrelated) child relations driven concurrently by `ParallelDriver.drive`, combined by a per-node combinator. v1 lands `unionAll` and `crossProduct`; `zipByKey` is parked in backlog (`parallel-async-gather-zip-by-key`). Manual-construction only — no optimizer recognition rule lands here (see `5.5-parallel-async-gather-union-all-rule`).
prereq: parallel-fanout-lookup-join-node, parallel-fanout-lookup-join-rule
files: packages/quereus/src/planner/nodes/plan-node-type.ts, packages/quereus/src/planner/nodes/async-gather-node.ts, packages/quereus/src/runtime/emit/async-gather.ts, packages/quereus/src/runtime/register.ts, packages/quereus/src/runtime/parallel-driver.ts, packages/quereus/test/runtime/async-gather.spec.ts, packages/quereus/src/planner/validation/plan-validator.ts, docs/runtime.md, docs/architecture.md
effort: xhigh
----

## Goal

Land the `AsyncGatherNode` physical N-ary relational node and its emitter so a manually-constructed plan can replace either:

- A chain of `SetOperationNode(op='unionAll')` over N uncorrelated children — driven concurrently and interleaved in arrival order, or
- A chain of N `JoinNode`s with no ON-clause bindings between them (true Cartesian) — driven concurrently and assembled into the full Cartesian product.

The node is **runtime artifact only**. The optimizer recognition rule for `unionAll` and the `parallel.gatherThresholdMs` tuning knob ship in `5.5-parallel-async-gather-union-all-rule` so:

1. The node can ship and be exercised manually against synthetic latency sources before the rule starts rewriting real plans.
2. The single golden-plan sweep is confined to the rule ticket's commit.

This ticket inherits the parallel-section in `OptimizerTuning` and the `expectedLatencyMs` / `concurrencySafe` `PhysicalProperties` fields that ticket `4.5-parallel-fanout-lookup-join-rule` adds (declared as a prereq). The node itself does not depend on those knobs — but the propagation rules established there are what the gather rule will read.

## Architecture

### Combinator union

```ts
export type AsyncGatherCombinator =
  | { readonly kind: 'unionAll' }
  | { readonly kind: 'crossProduct' };
  // zipByKey deferred — see backlog ticket parallel-async-gather-zip-by-key.
```

A discriminated union (rather than a string) so future combinators (`zipByKey`, `mergeOrdered`) can attach per-combinator config (key columns, ordering) without breaking the constructor signature.

### Plan node

```ts
export class AsyncGatherNode extends PlanNode implements RelationalPlanNode {
  override readonly nodeType = PlanNodeType.AsyncGather;
  constructor(
    scope: Scope,
    public readonly children: readonly RelationalPlanNode[],
    public readonly combinator: AsyncGatherCombinator,
    public readonly concurrencyCap: number,           // passed to ParallelDriver.drive
    public readonly preserveAttributeIds?: readonly Attribute[],
  ) {
    super(scope, /* cost = sum(children) */);
    if (children.length < 2) {
      quereusError(`AsyncGatherNode requires ≥ 2 children, got ${children.length}`, StatusCode.INTERNAL);
    }
    // crossProduct with no children is meaningless; unionAll with 1 child collapses to the child.
    // Enforce ≥ 2 at construction — recognition rule is responsible for not building degenerate nodes.
  }
  getChildren(): readonly PlanNode[] { return this.children; }
  getRelations(): readonly RelationalPlanNode[] { return this.children; }
  // withChildren rebuilds preserving combinator + cap + preserveAttributeIds, arity-checked.
}
```

#### Attribute layout

- **`unionAll`** — `children[0].getAttributes()` (mirrors `SetOperationNode.buildAttributes()` — left child's attribute IDs are preserved so downstream `ORDER BY` references continue to resolve). All children must have matching column counts and compatible types; the constructor validates the column-count invariant (`set-operation-node.ts:23-26` style).
- **`crossProduct`** — concatenation of all children's attributes in declared order. No re-IDing — children's attribute IDs flow through verbatim (children are uncorrelated, so there is no overlap risk).

`preserveAttributeIds` mirrors `BloomJoinNode` / `FanOutLookupJoinNode`: when the recognition rule rewrites a chained `SetOperationNode`, the original outer-tree's expected attribute IDs are recorded so the rewrite preserves consumer references.

#### Logical-node properties

- **Keys / FDs.**
  - `unionAll`: drop `monotonicOn`, `fds`, `equivClasses`, `constantBindings`, `domainConstraints` — same conservatism `SetOperationNode.computePhysical` already applies (`set-operation-node.ts:55-76`). The `isSet` flag on the relation type is `false` (UNION ALL allows duplicates).
  - `crossProduct`: union of children's FDs / equivClasses (each child's FDs hold on its slice of the output row); product of children's keys (Cartesian product key is the concatenation of any one key from each child). Mirror the helpers `JoinNode` already uses (`nodes/join-utils.ts`) — drive them N-ary by folding pairwise.
- **Ordering.** Both combinators drop ordering. Document this explicitly in the JSDoc and in `docs/runtime.md`: callers requiring total order must wrap the gather in `Sort`. Arrival order for `unionAll` is non-deterministic; Cartesian-product order for `crossProduct` is deterministic-but-unspecified (a function of the per-branch buffer order, itself a function of arrival order — see emitter below).
- **Nullability.** `unionAll` takes per-column nullability as the OR across children (same as today's `SetOperationNode` semantics — already handled by `RelationType` derivation). `crossProduct` keeps each child's per-column nullability unchanged.
- **`concurrencySafe`.** AND of children — propagated by the standard child-merge path (added in `4.5`).
- **`expectedLatencyMs`.** Max of children — same propagation rule the fanout rule established. The recognition rule (in `5.5`) consults this to decide whether to fire.

### Runtime emitter

```
emitAsyncGather(plan, ctx):
  childInsts = plan.children.map(c => emitCallFromPlan(c, ctx))
  driver = new ParallelDriver()

  if combinator.kind === 'unionAll':
    return { params: childInsts, run: runUnionAll, note: `async_gather(unionAll, N=${N})` }
  if combinator.kind === 'crossProduct':
    return { params: childInsts, run: runCrossProduct, note: `async_gather(crossProduct, N=${N})` }
```

Where each child instruction is a `(ctx: RuntimeContext) => AsyncIterable<Row>` factory. The runtime invocations:

#### `unionAll`

```
async function* runUnionAll(rctx, ...childFactories):
  forks = driver.fork(rctx, N)
  for await ({ branch: _i, value } of driver.drive(
    childFactories.map((f, i) => (forkCtx) => f(forkCtx)),
    forks,
    { concurrency: plan.concurrencyCap, signal: rctx.signal },
  )):
    yield value  // arrival order, no per-branch buffering beyond drive's internal one-slot
```

ParallelDriver.drive already handles strict-fork bookkeeping (`parallel-driver.ts:154-155, 281-282`) and cleanup on consumer break / branch throw via its internal `closeAll`. No manual `bumpParentForkCounter`/`dropParentForkCounter` needed (unlike `emitEagerPrefetch`).

#### `crossProduct`

```
async function* runCrossProduct(rctx, ...childFactories):
  forks = driver.fork(rctx, N)
  buffers: Row[][] = Array.from({ length: N }, () => [])
  for await ({ branch, value } of driver.drive(
    childFactories.map((f, i) => (forkCtx) => f(forkCtx)),
    forks,
    { concurrency: plan.concurrencyCap, signal: rctx.signal },
  )):
    buffers[branch].push(value)
  // All branches drained. If any branch is empty, the Cartesian product is empty.
  if (buffers.some(b => b.length === 0)) return
  yield* cartesianProduct(buffers)  // standard N-ary Cartesian generator
```

**Memory caveat.** `crossProduct` buffers every row of every branch before yielding. This is the same memory profile `JoinNode(cross)` already has when both sides are materialized — no new operational risk, but document the caveat in the node's JSDoc and in `docs/runtime.md`. There is no streaming variant in v1; if a branch is large, callers should not use `AsyncGather(crossProduct)`.

### Validator

Add `AsyncGather` to `plan-validator.ts` the same way `EagerPrefetch` / `FanOutLookupJoin` were added — i.e. **not** in the logical-only set; default physical-tree validation passes through. If the validator's tree walk requires explicit registration, register it; otherwise just verify via a new test case.

### Strict-fork compatibility

The emitter never mutates `rctx.context` or `rctx.tableContexts` directly — both combinators read parent bindings via the snapshot the fork establishes. No mutation-site allowlist update is required. Verify this with one strict-mode test in the spec (mirroring `eager-prefetch.spec.ts`).

## Tests

`packages/quereus/test/runtime/async-gather.spec.ts` (new). Hand-built plans, mirroring `eager-prefetch.spec.ts` / `fanout-lookup-join.spec.ts` style. No SQL or golden-plan tests in this ticket — those land with the rule.

### `unionAll`

- **Three branches, ascending IDs per branch.** Assert the output contains all rows from all branches (set equality, since arrival order is non-deterministic). N=3, branches yield `[1,2,3]`, `[4,5,6]`, `[7,8,9]`.
- **Empty branch.** One of three branches yields zero rows → output is the union of the remaining two branches.
- **All-empty.** All branches yield zero rows → empty output.
- **Concurrency.** Three branches each `await setTimeout(resolve, 50)` before yielding their single row; with `concurrencyCap=3`, total wall-clock ≈ 50ms (one fork). With `concurrencyCap=1`, ≈ 150ms (serial). Same wide bands as existing parallel-driver tests (75–175ms for ~100ms target).
- **`concurrencyCap < N`.** N=4, cap=2, 50ms per branch → ≈ 100ms (two waves).
- **Outer ordering not preserved.** Two branches each yield `[1,2,3]` deterministically; assert the output is *not* required to be `[1,1,2,2,3,3]` (test asserts the multiset of values, never the order). Lock the "no ordering claim" invariant explicitly in a comment.
- **Consumer break.** Consumer breaks after one row → `drive`'s close path fires on all in-flight branches; no unhandled rejection.
- **Branch throws.** One branch throws mid-stream → the thrown value propagates out of the gather; siblings are best-effort closed.
- **Strict-fork mode.** Run the spec under `QUEREUS_FORK_STRICT=1`; add one case asserting a parent-context mutation while the gather is live throws.

### `crossProduct`

- **Two branches, both non-empty.** B0 yields `[A, B]`, B1 yields `[1, 2]` → output is `[A,1], [A,2], [B,1], [B,2]` (multiset; per-pair internal order not pinned because buffer-order depends on arrival).
- **One branch empty → empty product.** B0 yields `[A]`, B1 yields nothing → empty output (no rows). Lock this invariant — it is the difference from `unionAll`.
- **All branches non-empty, three-way.** N=3, sizes 2/3/4 → 24 rows in output. Verify by size + multiset.
- **Concurrency on production phase.** Three branches each take 50ms to produce; with cap=3, total wall-clock dominated by 50ms (production) + the (trivial) Cartesian emit time. With cap=1, ≈ 150ms.
- **Memory caveat documentation.** Not a test — a JSDoc note that an N-way `crossProduct` materializes all branches before yielding the first row.

### Cross-cutting

- **`withChildren` arity.** Constructing `AsyncGatherNode(N=2)` then calling `withChildren([only one child])` throws. Mirrors `EagerPrefetchNode`'s arity check.
- **Construction-time guard `N < 2` throws.** Lock the "no degenerate gather" invariant.
- **`unionAll` column-count mismatch throws.** Build two children with different column counts → constructor throws (mirrors `SetOperationNode.buildAttributes` validation).
- **Validator pass-through.** Build a tree containing `AsyncGatherNode` and run it through `validatePhysicalTree`; assert it passes.

## Docs

- `docs/runtime.md` — new subsection "AsyncGatherNode" alongside the EagerPrefetch and FanOutLookupJoin entries. Cover:
  - The two combinators (`unionAll` arrival-order interleave; `crossProduct` materialized Cartesian).
  - The dropped-ordering / dropped-FDs invariants.
  - The `crossProduct` memory caveat.
  - The `concurrencyCap` semantic and its relation to `tuning.parallel.concurrency`.
  - A pointer forward to the `5.5` recognition rule for `unionAll`.
- `docs/architecture.md` — one bullet under runtime/optimizer overview pointing at the new node and the deferred rule. Mention `zipByKey` is parked in backlog.

## TODO

Phase 1 — node and validator scaffolding

- Add `AsyncGather = 'AsyncGather'` to `PlanNodeType`.
- Create `nodes/async-gather-node.ts` with the combinator-union, constructor (with arity + column-count checks), attribute composition, key/FD derivation (`unionAll` drops; `crossProduct` folds pairwise), `withChildren`, `toString`, `getLogicalAttributes`.
- Verify validator pass-through — should mirror `EagerPrefetch`/`FanOutLookupJoin`. If it doesn't, add explicit registration.

Phase 2 — emitter

- Implement `runtime/emit/async-gather.ts`:
  - Switch on `plan.combinator.kind`.
  - `unionAll`: drive + yield arrival.
  - `crossProduct`: drive + buffer per branch + N-ary Cartesian generator. Extract `cartesianProduct(buffers: Row[][]): Generator<Row>` as a local helper (small enough to keep colocated; do not over-engineer to a util).
- Wire into `runtime/register.ts`.

Phase 3 — tests

- Write `test/runtime/async-gather.spec.ts`. Reuse the `RuntimeContext` factory + synthetic source generators + AbortController plumbing from `eager-prefetch.spec.ts` / `fanout-lookup-join.spec.ts`.
- Add one strict-fork mode case.

Phase 4 — docs

- Update `docs/runtime.md` and `docs/architecture.md`.

## Honest gaps the next agent should call out in the review handoff

- `zipByKey` is deferred to a separate backlog ticket. The combinator union is intentionally extensible so the third variant slots in without re-shaping the constructor.
- No optimizer rule for either combinator lands here. `unionAll` recognition is the next ticket (`5.5`). `crossProduct` recognition is deliberately not planned in this track — it is opt-in only.
- `crossProduct` buffers all branches in memory before yielding the first row. No streaming variant; not a v1 goal.
- `expectedLatencyMs`/`concurrencySafe` propagation is supplied by `4.5-parallel-fanout-lookup-join-rule`; the gather node merely inherits the propagation. If `4.5` lands the propagation differently than this ticket's assumption (max for latency, AND for concurrencySafe), update the gather node's docstring accordingly.
- Per-branch starvation under skewed production speeds is possible (a fast branch's slot in `drive`'s arrival queue can crowd out a slow branch's first row when `concurrencyCap < N`). v1 accepts this. Adaptive scheduling is parked.
- No FD-propagation primitives for the N-ary shape are introduced; `crossProduct` reuses the binary-join FD machinery in a fold. Conservative but correct.

## End
