description: Review of `EagerPrefetchNode.computePhysical` override that restores pass-through relational claims (ordering/fds/equivClasses/constantBindings/domainConstraints/monotonicOn) dropped by the default child-merge, plus a corrected docstring and regression tests.
files: packages/quereus/src/planner/nodes/eager-prefetch-node.ts, packages/quereus/src/planner/nodes/limit-offset.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/test/optimizer/parallel-eager-prefetch-probe.spec.ts
----

## What changed

`EagerPrefetchNode` is a runtime-only FIFO ring-buffer pass-through, but it
never overrode `computePhysical`, so the default child-merge in
`PlanNode.physical` (`plan-node.ts:540-570`) silently dropped every relational
claim — `ordering`, `fds`, `equivClasses`, `constantBindings`,
`domainConstraints`, `monotonicOn`. The default merge only carries
`deterministic`/`idempotent`/`readonly`/`expectedLatencyMs`/`concurrencySafe`.

This is a missed-optimization correctness defect (never wrong rows — the buffer
is FIFO so runtime order is correct), made live by `ruleEagerPrefetchProbe`
wrapping the probe side of a high-latency hash join: `BloomJoinNode` reads
`childrenPhysical[0]` for join-key coverage / FD propagation, so the weakened
prefetch physical defeated downstream Sort/Distinct/streaming-aggregate elision.

### Implementation

- Added `computePhysical(childrenPhysical)` to `EagerPrefetchNode`, mirroring
  `LimitOffsetNode.computePhysical` (`limit-offset.ts:71-85`). It propagates
  `estimatedRows`/`ordering`/`fds`/`equivClasses`/`constantBindings`/
  `domainConstraints`/`monotonicOn` from `childrenPhysical[0]`.
- **Deliberately omitted** `accessCapabilities` and `rangeBoundedOn` — these are
  access-path-local (see `plan-node.ts:231-263`), live only on the physical
  leaf, and must NOT carry through single-input pass-through nodes. Also omitted
  the default-merge flags so they aren't redundantly respecified.
- Imported `PhysicalProperties` into `eager-prefetch-node.ts`.
- Rewrote the class docstring: removed the false "computePhysical is not
  overridden / default merge keeps them" claim; now states the claims pass
  through via the explicit override and that access-path-local claims do not.

## Tests added (in `parallel-eager-prefetch-probe.spec.ts`)

- `propagates relational physical claims through the wrap` — builds a
  `MockRelNode` declaring `ordering`/`fds`/`equivClasses`/`monotonicOn` (via the
  `physical` override, which `MockRelNode.computePhysical` returns verbatim),
  wraps it in `EagerPrefetchNode`, asserts each survives on `.physical`.
- `does NOT propagate access-path-local claims through the wrap` — sets
  `accessCapabilities`/`rangeBoundedOn` on the child, asserts both are
  `undefined` on the prefetch's physical (the pass-through-must-not-carry
  invariant).

## Validation performed

- `yarn workspace @quereus/quereus run build` — clean (exit 0).
- Prefetch spec: 14 passing (12 pre-existing + 2 new).
- Full `test/optimizer/**` + `test/plan/**`: **1051 passing**, exit 0.
- `yarn lint` — clean (exit 0).

## Review focus / known gaps

- **Did NOT run the full `yarn test` suite** (logic/sqllogic + store paths) —
  only the optimizer/plan specs, which are the directly-affected subsystem. A
  reviewer may want to confirm the broader logic suite, since strengthening the
  join's physical claims could (intentionally) change plan shapes elsewhere
  (Sort/Distinct/streaming-aggregate elision). No such regression appeared in
  the 1051 specs run, but those don't cover the full sqllogic corpus.
- **Did NOT verify the test fails without the fix** by reverting — the mechanism
  is well-understood (default merge demonstrably omits `ordering`), but the
  ticket's claim that "the first assertion fails without the fix" was not
  empirically reconfirmed this run.
- The new tests assert claims survive on a `MockRelNode` whose
  `computePhysical` returns the override verbatim; they exercise the
  `EagerPrefetch` propagation in isolation, not the end-to-end join FD/ordering
  propagation through a real `BloomJoinNode`. A reviewer wanting end-to-end
  coverage could add an assertion on the wrapping join's `.physical` ordering/fds
  in the high-latency SQL scenario (`joinSQL`), confirming the downstream payoff.
