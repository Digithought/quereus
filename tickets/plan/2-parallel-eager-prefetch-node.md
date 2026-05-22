description: EagerPrefetchNode — wrap a single sub-tree and start iterating into a bounded buffer the moment the parent emits. Smallest end-to-end consumer of ParallelDriver; primarily a latency hider for remote-vtab scans.
prereq: parallel-driver-context-fork, parallel-runtime-fork-test-harness
files: packages/quereus/src/planner/nodes/plan-node-type.ts, packages/quereus/src/planner/nodes/, packages/quereus/src/runtime/emit/, packages/quereus/src/planner/rules/, packages/quereus/src/runtime/parallel-driver.ts
----

## Goal

A physical pass-through node `EagerPrefetchNode(child, bufferSize)` that wraps a single relational sub-tree. At emit time it kicks off the child iterator on a forked context and pushes rows into a bounded ring buffer; the consumer awaits the buffer. Output rows, ordering, FDs, ECs, and keys all match the wrapped child verbatim — only timing changes.

## Use case

Two siblings of a binary operator (typically a join) where one side latency-dominates the other. Today the dominant side blocks the other from even starting; `EagerPrefetchNode` over one or both sides lets their first round-trips overlap.

Concrete first target: the right side of a hash join over a remote vtab. The build phase waits on the network anyway; starting the probe scan's first batch concurrently is pure latency saved.

## Why this is the next step after parallel-driver-context-fork

`EagerPrefetchNode` is the smallest plan-node consumer of `ParallelDriver` — N=1, no combinator. It exercises the driver end-to-end through real emit + execution without requiring optimizer pattern matching or new vtab contracts. If anything in the driver fails to survive contact with a real emitter, surfacing it here is much cheaper than discovering it inside `FanOutLookupJoin`.

## Properties

- **Logical equivalence.** Output rows = input rows in input order. All physical properties pass through unchanged.
- **Cost.** `bufferSize` items of memory; no CPU beyond the iteration itself. Net latency win is proportional to how much the wrapped subtree's first-row time exceeds the consumer's per-row work.
- **Cancellation.** If the consumer breaks early or downstream throws, the buffered rows are discarded and the inner iterator is `return()`-closed via the driver's existing cancellation path.

## Open questions for the plan agent

- **Buffer policy.** Static `bufferSize` (start with 64) vs. adaptive. Default to static — adaptive is a follow-up.
- **Wrap criteria.** Three increasingly broad heuristics:
  1. Manually-constructed only (no recognition rule). Useful for testing; no production effect.
  2. A post-optimization rule that wraps the right (probe) side of physical hash joins.
  3. A broader rule that wraps any subtree whose `expectedLatencyMs` exceeds a tuning threshold.
  Picking among these is the plan-stage decision.
- **Tracing.** Buffer fill rate is diagnostic gold; decide whether to surface it via `InstructionRuntimeStats` or wait for a dedicated telemetry pass.
- **Interaction with cache nodes.** `CacheNode` already materializes its child; wrapping a cached child in `EagerPrefetchNode` is redundant. Detect and skip in the rule.

## Out of scope

- Eager prefetch of join *outer* sides (windowed prefetch is a different operator shape).
- Speculative prefetch across operator boundaries. `EagerPrefetchNode` starts when emit reaches it; cross-operator speculation is a separate concept entirely.
