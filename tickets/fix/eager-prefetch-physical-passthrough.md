description: `EagerPrefetchNode` silently drops physical claims (ordering, fds, equivClasses, monotonicOn, constantBindings, domainConstraints) because it does not override `computePhysical`. Its docstring falsely claims these "pass through verbatim". The `eager-prefetch-probe` rule (just landed) is the first thing to insert `EagerPrefetchNode` into real plans, so it activates this latent defect: a prefetch-wrapped probe loses its ordering/key/FD claims, and the hash join above it — and everything above that — sees a weaker physical, defeating downstream sort / distinct / streaming-aggregate elision.
files: packages/quereus/src/planner/nodes/eager-prefetch-node.ts, packages/quereus/src/planner/nodes/limit-offset.ts, packages/quereus/test/optimizer/parallel-eager-prefetch-probe.spec.ts
----

## Symptom

`EagerPrefetchNode` is a pure pass-through (row count, order, attribute IDs all
unchanged at runtime — the buffer is FIFO). Its class docstring asserts:

> Rows, order, attribute IDs, keys, FDs, equivClasses, orderings, monotonicity
> all pass through verbatim. computePhysical is not overridden — the default
> child-merge keeps deterministic/idempotent/readonly from the source unchanged.

That second sentence is the bug. The default child-merge in `PlanNode.physical`
(`plan-node.ts:545-567`) only derives `deterministic`, `idempotent`,
`readonly`, `expectedLatencyMs`, and `concurrencySafe` from children. It does
**not** carry `ordering`, `fds`, `equivClasses`, `monotonicOn`,
`constantBindings`, or `domainConstraints`. A node that wants those preserved
must propagate them in `computePhysical` — exactly as `LimitOffset` does
(`limit-offset.ts` `computePhysical`). `EagerPrefetchNode` does not override
`computePhysical` at all, so every one of those claims is dropped.

### Confirmed empirically

A source node declaring `ordering`/`fds`/`equivClasses`/`monotonicOn`, wrapped
in `EagerPrefetchNode`, yields `physical.ordering === undefined` (and likewise
the rest). The runtime order is still correct (FIFO buffer), so this never
produces wrong rows — it is a **missed-optimization correctness defect**: the
static claims vanish.

## Why it matters now

Before `eager-prefetch-probe` landed, nothing inserted `EagerPrefetchNode` into
a plan, so the defect was inert. That rule now wraps the probe (`left`) side of
a high-latency hash join. When it fires (only over a remote-vtab build today,
so the blast radius is currently the synthetic test fixture — but real once a
remote vtab plugin ships):

- `BloomJoinNode.computePhysical` reads `childrenPhysical[0]` (now the
  EagerPrefetch's physical) for join-key coverage and FD propagation. With the
  probe's `fds`/`equivClasses`/`ordering` gone, the join's own output
  `preservedKeys` / `fds` / `ordering` come out weaker.
- Anything above the join that would have elided a Sort, a Distinct, or chosen
  a streaming aggregate based on the join's ordering/keys can no longer do so.

Dropping claims is conservative (never wrong rows), so this is not a data-
correctness emergency — but it silently defeats the very pipelining the parallel
rules exist to enable, which is worth fixing before a remote vtab makes the rule
fire for real.

## Fix

Override `computePhysical` on `EagerPrefetchNode` to propagate the pass-through
relational claims from its single child, mirroring `LimitOffset.computePhysical`
(`ordering`, `fds`, `equivClasses`, `constantBindings`, `domainConstraints`,
`monotonicOn`, plus `estimatedRows`). Do **not** propagate the
access-path-local flags (`accessCapabilities`, `rangeBoundedOn`) — per the
`PhysicalProperties` doc those live only on the physical leaf where the access
plan resolved and pass-through nodes must not carry them (same rule LimitOffset
already follows by omitting them).

Then correct the class docstring: the claims pass through because
`computePhysical` propagates them, not because the default merge does.

## Test

Add a regression assertion (the existing
`parallel-eager-prefetch-probe.spec.ts` is the natural home, or a dedicated
node spec): build a source node that declares `ordering` / `fds` /
`equivClasses` / `monotonicOn`, wrap it in `EagerPrefetchNode`, and assert each
survives on `.physical`. Without the fix this fails on the first assertion
(`ordering` is `undefined`); with it, all pass.
