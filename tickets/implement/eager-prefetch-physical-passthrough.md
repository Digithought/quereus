description: `EagerPrefetchNode` drops physical relational claims (ordering, fds, equivClasses, monotonicOn, constantBindings, domainConstraints) because it never overrides `computePhysical`. Add the override (mirroring `LimitOffset`) so a prefetch-wrapped probe keeps its claims, and correct the misleading docstring.
files: packages/quereus/src/planner/nodes/eager-prefetch-node.ts, packages/quereus/src/planner/nodes/limit-offset.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/test/optimizer/parallel-eager-prefetch-probe.spec.ts
----

## Problem (confirmed)

`EagerPrefetchNode` is a runtime-only FIFO pass-through: row count, order, and
attribute IDs are all identical at runtime. Its docstring claims keys/FDs/ECs/
orderings/monotonicity "pass through verbatim" and that `computePhysical` need
not be overridden because the default merge keeps them.

That is false. The default child-merge in `PlanNode.physical`
(`plan-node.ts:548-565`) derives only `deterministic`, `idempotent`,
`readonly`, `expectedLatencyMs`, and `concurrencySafe` from children. It does
**not** carry `ordering`, `fds`, `equivClasses`, `monotonicOn`,
`constantBindings`, or `domainConstraints`. Because `EagerPrefetchNode` never
overrides `computePhysical`, all of those claims are silently dropped on its
output.

This never produces wrong rows (the buffer is FIFO, so runtime order is
correct) — it is a **missed-optimization correctness defect**: the static
claims vanish. It became live now that `ruleEagerPrefetchProbe` wraps the probe
(`left`) side of a high-latency hash join: `BloomJoinNode.computePhysical`
reads `childrenPhysical[0]` (the EagerPrefetch's now-weaker physical) for
join-key coverage / FD propagation, so the join's own `ordering`/`fds`/
`preservedKeys` come out weaker, defeating downstream Sort / Distinct /
streaming-aggregate elision.

## Fix

Mirror `LimitOffsetNode.computePhysical` (`limit-offset.ts:71-85`) exactly.
`EagerPrefetchNode` has a single relational child (`childrenPhysical[0]`), so
the override propagates the pass-through relational claims:

- `estimatedRows` (from `this.estimatedRows`)
- `ordering`
- `fds`
- `equivClasses`
- `constantBindings`
- `domainConstraints`
- `monotonicOn`

Do **NOT** propagate `accessCapabilities` or `rangeBoundedOn`. Per the
`PhysicalProperties` doc (`plan-node.ts:231-263`) these are access-path-local
and live only on the physical leaf where the access plan resolved; single-input
pass-through nodes MUST NOT carry them (LimitOffset already omits them). The
default merge handles `deterministic`/`idempotent`/`readonly`/
`expectedLatencyMs`/`concurrencySafe`, so the override should not respecify
those.

Then rewrite the class docstring: the claims pass through because
`computePhysical` propagates them from the child, not because the default merge
does. Remove the false "computePhysical is not overridden" sentence.

## Test

Add a regression assertion. The existing
`parallel-eager-prefetch-probe.spec.ts` is the natural home and already has a
`MockRelNode` that takes a `physical` override and a `mockScope` — reuse them.
Build a `MockRelNode` declaring `ordering`, `fds`, `equivClasses`, and
`monotonicOn`, wrap it in `EagerPrefetchNode`, and assert each survives on
`.physical`. Without the fix the first assertion (`ordering`) fails (it is
`undefined`); with it, all pass. Also assert `accessCapabilities` /
`rangeBoundedOn` set on the child do NOT appear on the prefetch's physical
(the pass-through-must-not-carry invariant).

Note: `MockRelNode.computePhysical` returns the override verbatim, so set the
relational claims directly in the `physical` option. Use the existing
`makeAttr` helper for attribute IDs and reference those IDs in `fds` /
`equivClasses` / `monotonicOn` / `ordering` (ordering uses column indices).

## Validation

- `yarn workspace @quereus/quereus run build`
- `yarn workspace @quereus/quereus test` (or narrow to the optimizer specs);
  stream with `2>&1 | tee /tmp/test.log; tail -n 80 /tmp/test.log`
- lint the touched files

## TODO

- [ ] Add `computePhysical(childrenPhysical)` override to `EagerPrefetchNode`
      propagating `estimatedRows`/`ordering`/`fds`/`equivClasses`/
      `constantBindings`/`domainConstraints`/`monotonicOn`; omit
      `accessCapabilities`/`rangeBoundedOn` and the default-merge flags.
- [ ] Import `PhysicalProperties` type into `eager-prefetch-node.ts` (currently
      not imported).
- [ ] Rewrite the class docstring to state the claims pass through via the
      override, removing the false "not overridden / default merge keeps them"
      claim.
- [ ] Add the regression test described above to
      `parallel-eager-prefetch-probe.spec.ts`.
- [ ] Build, test, lint.
