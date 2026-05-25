description: Review the cost-model recognition rule (`rule-fanout-batched-outer`) that flips an already-formed `FanOutLookupJoinNode` from `serial` to `batched` outer mode. Implemented, built, linted, full suite green.
prereq: parallel-fanout-lookup-join-batched-outer
files: packages/quereus/src/planner/rules/join/rule-fanout-batched-outer.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/optimizer-tuning.ts, packages/quereus/test/optimizer/parallel-fanout-batched.spec.ts, docs/optimizer.md, docs/runtime.md
----

## What landed

A new PostOptimization rule, **`rule-fanout-batched-outer`** (priority 16, matching
`PlanNodeType.FanOutLookupJoin`), that flips an already-formed `FanOutLookupJoinNode`
from the default `serial` outer mode to `batched`. It is a *post-pass* over the node
`rule-fanout-lookup-join` builds in `Structural` — by PostOptimization, physical
selection has finalized leaf `expectedLatencyMs` / `estimatedRows` / `concurrencySafe`.

**Decision logic (all must hold, else stay serial):**

- `node.outerMode !== 'batched'` (idempotence) and **no `cross` branch** (cross +
  batched is deferred to `parallel-fanout-lookup-join-cross-mode`).
- `branchCount < tuning.parallel.outerBatchConcurrency` — per-row branch count
  under-saturates the global budget (the precondition that makes cross-row admission
  worthwhile).
- `max(branch.expectedLatencyMs) >= tuning.parallel.batchedOuterThresholdMs` (new
  knob, default 25 ms) — slowest branch high-latency. 0 on memory-vtab leaves ⇒ inert.
- `outerRowEstimate(outer) >= tuning.parallel.batchedOuterMinRows` (new knob, default
  256) — large outer cardinality. Unknown estimate **fails** the gate.
- `outer.physical.concurrencySafe === true` — the batched driver pumps the outer
  concurrently with branch forks (serial never did).

**On flip:** rebuilds the node with `outerMode='batched'` and the outer wrapped in an
`EagerPrefetchNode` (buffer = `maxOuterReadAhead`), preserving `branches`,
`concurrencyCap`, `preserveAttributeIds`.

**Two new tuning knobs** in `OptimizerTuning.parallel`: `batchedOuterThresholdMs` (25),
`batchedOuterMinRows` (256). (`outerBatchConcurrency` / `maxOuterReadAhead` already
existed from the runtime ticket.)

## Key design decisions (verify these)

- **`outerRowEstimate` helper.** `AliasNode` (and other pass-throughs) propagate
  `estimatedRows` via the `.estimatedRows` *getter*, which leaf access nodes do not all
  populate even though their `physical.estimatedRows` is set — so `outer.physical.
  estimatedRows` is `undefined` on an aliased table outer (`orders o`). The rule reads
  the node's own estimate, then descends *single-relation* pass-throughs to recover the
  leaf's `physical.estimatedRows`. A multi-relation (join) outer returns `undefined` ⇒
  gate fails (conservative). **Reviewer: confirm this descent is sound for the outer
  shapes the formation rule can produce (single-table spine outer; subquery-cluster
  outer may be more complex).** This is arguably a symptom of inconsistent
  `estimatedRows` getter-vs-physical propagation across nodes — out of scope to fix here,
  but worth a glance.

- **EagerPrefetch wrap = the answer to the ticket's "must verify before shipping"
  outer-source/shared-context concern.** The batched driver pumps the outer
  concurrently with live per-row forks. Wrapping the outer in `EagerPrefetchNode` runs
  the outer sub-plan against the prefetch's *own* forked context, so its mutations land
  on the fork (never on the shared `rctx.context` that per-row forks bump); the batched
  pump then drains a pure buffer (`buf.shift()`), which never touches `rctx.context`.
  This neutralizes **both** documented hazards: (a) torn reads of a non-outer context
  entry the outer mutates mid-pump, and (b) the strict-fork violation when the fan-out
  is nested under another fork. Branch correlations are additionally safe by
  construction (the formation rule only clusters branches referencing the isolated
  outer-row attributes). Decision: **batched implies prefetch** (reverse does not hold).

## Use cases / validation

`test/optimizer/parallel-fanout-batched.spec.ts` (8 cases, all passing; mirrors the
`parallel-fanout.spec.ts` high-latency-module + `concurrency`-lowering harness, and
overrides `batchedOuterMinRows: 0` so the synthetic memory outer — `estimatedRows = 0`
— clears the cardinality gate):

- **flips to batched** when all gates pass; asserts `outerMode === 'batched'` AND the
  plan contains an `EagerPrefetch` (the wrap).
- **leaves serial / no fan-out** on local-only memory plans (formation gate never fires).
- **does NOT flip** when: slowest branch latency `< batchedOuterThresholdMs` (raised to
  100); `branchCount >= outerBatchConcurrency` (set to 3); outer estimate `<
  batchedOuterMinRows` (default 256 vs estimate 0); `disabledRules` contains
  `fanout-batched-outer`; any branch is `cross`.
- **execution equivalence over a real outer plan** (`forkExecTest`): batched output ==
  serial baseline (rule disabled), exact rows asserted. This is the end-to-end check
  that the EagerPrefetch-wrapped batched plan produces correct output.

Validation run:
- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- Full suite (`node test-runner.mjs`) — **3562 passing, 0 failing, 9 pending**. Golden
  plan sweep unchanged (3 golden cases pass; rule inert on memory plans).
- `--fork-strict --grep "ruleFanOut..."` — 32 passing, execution tests skip as designed.

## Known gaps / honest flags (treat tests as a floor)

- **Strict-fork outer safety is reasoned + structural, NOT exercised under
  `QUEREUS_FORK_STRICT=1`.** Every fan-out *execution* test skips under strict-fork
  because of the pre-existing Sort/Project-above-fan-out strict-fork false positive
  (documented in `parallel-fanout.spec.ts` and `docs/runtime.md`). Since the recognition
  rule is Project-rooted, any batched plan has a Project above it, so that false positive
  fires *first* under strict — masking a direct test of the outer-pump fix. The fix is
  the EagerPrefetch isolation traced above; a reviewer wanting hard confirmation would
  need either (a) a way to run a fan-out under strict-fork without the Project-above
  false positive, or (b) a unit test driving `runFanOutLookupJoinBatched` with an
  outer source that mutates `rctx.context`, under a strict-wrapped parent context.
  Neither is in this ticket.

- **No timing/overlap test.** The rule only *selects* batched; the runtime ticket owns
  the cross-row-overlap timing assertions. This ticket asserts plan shape + correctness,
  not that batched is actually faster.

- **Cardinality gate is effectively only exercised at estimate = 0** (memory fixtures).
  The "would fire at min=0, rejects at min=256" pair proves the comparison direction,
  but no test feeds a real positive `estimatedRows` (no remote-vtab stat fixture in
  tree). Same limitation the fan-out cost-gate and cross-guard tests already carry.

- **`batchedOuterMinRows` default (256) is a first-cut.** Anchored at ≈4× the
  read-ahead window; no empirical tuning. Reasonable but unvalidated against a real
  high-latency workload.

## Deferred (already ticketed, do not re-open here)

- `parallel-fanout-lookup-join-cross-mode` — streaming `cross` + batched outer; this
  rule explicitly refuses to flip any node carrying a `cross` branch.
