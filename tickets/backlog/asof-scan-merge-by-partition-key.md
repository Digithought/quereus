---
description: Add a co-streaming (merge-by-partition-key) emitter strategy for AsofScan as a cost-model-selectable alternative to the hash-bucketed one
prereq: asof-scan-via-lateral-top1
files: packages/quereus/src/runtime/emit/asof-scan.ts, packages/quereus/src/planner/nodes/asof-scan-node.ts, packages/quereus/src/planner/rules/join/rule-lateral-top1-asof.ts
---

## Background

The first AsofScan implementation (ticket `asof-scan-via-lateral-top1`) ships a
hash-bucketed emitter that buffers the entire right input keyed by partition,
then streams left rows through. Memory cost: O(R). Latency: O(R) startup before
the first emit.

The "merge-by-partition-key" alternative co-streams both inputs:

- Outer merge over the partition key (both inputs ordered by partition).
- Inner per-partition merge over the match attribute.

When both inputs are co-partitioned in the same key order — which is the common
shape when both come from the same sorted store, or when an upstream `Sort`
established it — this strategy uses O(P) memory (P = number of in-flight
partitions, typically 1 for tight co-iteration) and emits incrementally.

## When this strategy wins

- Right side is huge (millions of rows per partition) — buffering is wasteful.
- Both sides are already partition-ordered — no extra Sort needed.
- Streaming output matters (downstream LIMIT, network sink, etc.).

## When the hash-bucketed strategy stays the right choice

- Left and right are NOT co-partitioned in the same key order — co-streaming
  would need an upstream Sort on one side; the hash strategy already handles
  this without that sort.
- Right is small enough that the buffer is cheap.
- Partition cardinality is high relative to per-partition row count — the
  per-partition cursor map in the hash strategy is roughly the same size.

## Architecture sketch

Add a `strategy: 'hash' | 'merge'` discriminator to `AsofScanNode` (default
`'hash'` to preserve current behavior), or introduce a sibling node
`AsofScanMerge` if the cost-model selection logic is cleaner that way.

The rule (or a new physical-selection rule on `AsofScan`) chooses based on:

- Left and right both expose `physical.ordering` matching `[partitionAttrs..., matchAttr]`
  in compatible directions.
- Estimated right row count > a tunable threshold (default ~10k) — below the
  threshold, hash buffering is cheaper than the merge-state bookkeeping.

## TODO

### Emitter

- Add `emitAsofScanMerge(plan, ctx): Instruction` next to the existing
  `emitAsofScan`. Co-streaming logic:
  - Maintain `leftIter`, `rightIter`.
  - Outer loop: advance both iterators to the same partition key (whichever is
    behind catches up; rows from the side that's ahead-but-unmatched on the
    left are NULL-padded if `outer`, dropped if not).
  - Inner loop within a partition: advance right while
    `right.match <op> left.match`; emit `(left, last_advanced_right)` per left
    row; transition to next partition when either side's partition key
    changes.
- Dispatch in `runtime/emit/asof-scan.ts`: switch on `plan.strategy`.

### Plan-node + rule

- Either (a) add `strategy` field to `AsofScanNode` and have the rule pick
  based on physical properties, or (b) introduce a new selection rule on
  `AsofScan` that swaps strategies post-construction. Option (b) keeps the
  recognition rule simple.
- Update plan-shape tests to cover both strategies and the selection criteria.

### Cost model

- `AsofScanNode.computePhysical` (or a dedicated cost helper) should return
  different cost estimates for the two strategies so the optimizer picks
  correctly. Hash: cost ≈ `L + R` plus `R · log(partitions)` for bucket
  insert (use partition cardinality estimate); Merge: cost ≈ `L + R` plus
  any required Sort cost.

### Tests

- Plan-shape: query whose left and right are co-partition-ordered selects
  `merge`; query without compatible ordering selects `hash`.
- SQL-logic: equivalence between the two strategies on the same data.
