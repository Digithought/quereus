---
description: Add a co-streaming (merge-by-partition-key) emitter strategy for AsofScan as a cost-model-selectable alternative to the hash-bucketed one
prereq: asof-scan-via-lateral-top1
files:
  - packages/quereus/src/planner/nodes/asof-scan-node.ts
  - packages/quereus/src/runtime/emit/asof-scan.ts
  - packages/quereus/src/planner/rules/access/rule-asof-strategy-select.ts
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/src/planner/optimizer-tuning.ts
  - packages/quereus/test/optimizer/asof-scan.spec.ts
  - packages/quereus/test/logic/84-asof-scan.sqllogic
  - docs/optimizer.md
---

## Background

`asof-scan-via-lateral-top1` shipped a hash-bucketed emitter for `AsofScanNode`:
the right input is fully bucketed by partition key into `Map<string, Row[]>`,
then the left streams through with a per-bucket cursor. Memory: O(R). Latency:
all R right rows must arrive before the first emit.

This ticket adds a **co-streaming** alternative — merge-by-partition-key —
that consumes both inputs in lockstep when both are pre-ordered by
`[partition cols..., matchAttr]`. Memory: O(1) (one in-flight partition).
Latency: emits as left rows arrive. The optimizer picks between the two
strategies based on the children's `physical.ordering` and the right's
estimated row count.

## Architecture

### `AsofScanNode.strategy: 'hash' | 'merge'`

Add a `strategy` discriminator to `AsofScanNode`. Default to `'hash'` —
preserves today's behavior unmodified, since the recognition rule does not
have access to propagated physical properties when it fires (Structural pass,
before bottom-up physical/access-path runs).

`computePhysical` is unchanged; left's `ordering`/`monotonicOn` still
propagates regardless of strategy. `getTotalCost`/`estimatedRows` are also
unchanged (the work is still O(L + R) — the difference is constant-factor /
memory).

`withChildren` and the constructor thread `strategy` through. `toString()`
and `getLogicalAttributes()` include it so plan-shape tests can assert on it.

### `rule-asof-strategy-select` (new, in `rules/access/`)

A bottom-up rule on `PlanNodeType.AsofScan`, registered in `PassId.PostOptimization`
phase `'impl'` after `monotonic-range-access` (priority 9) so the leaves'
`physical.ordering`/`monotonicOn` are already finalized. Suggested priority **11**
(between range-access at 9 and `mutating-subquery-cache` at 10 — actually
after `mutating-subquery-cache` so it operates on the final AsofScanNode
shape; 11 is fine).

Algorithm:

1. Skip when `node.strategy !== 'hash'` (idempotent).
2. Compute the required *partition-attr-id sequence* on each side from the
   children's `physical.ordering`:
   - Take the leading `partitionAttrs.length + 1` ordering entries.
   - Map each entry's `column` index to the corresponding child attribute's
     `id` and direction (`asc` / `desc`).
3. Validate the partition prefix on each side:
   - The first `partitionAttrs.length` entries' attr-ids must be a permutation
     of `partitionAttrs[*].leftAttrId` (left side) / `partitionAttrs[*].rightAttrId`
     (right side).
   - The permutation chosen on left and right must pair up via the
     `partitionAttrs` equi-pairs — i.e. for each ordering position `i`, the
     left's i-th partition attr-id and the right's i-th partition attr-id
     belong to the *same* `AsofAttrPair`.
   - Directions at each position must match between left and right.
4. The trailing entry on each side must be the match attribute
   (`matchAttr.leftAttrId` / `matchAttr.rightAttrId`).
   - Direction must match `node.direction` (`'asc'` → ordering `asc`,
     `'desc'` → ordering `desc`). The hash emitter already handles both
     directions; the merge emitter will too.
5. Threshold gate: bail when
   `(node.right.estimatedRows ?? defaultRowEstimate) < tuning.asof.mergeRowThreshold`.
   Below the threshold, hash buffering is cheaper than merge-state bookkeeping.
6. On all checks passing, return `node` with `strategy='merge'` (via a new
   `node.withStrategy('merge')` helper, since `withChildren` should not be
   the strategy mutator).

Bail to `null` (leaving `'hash'`) on any failure.

### Tuning

Add to `OptimizerTuning`:

```ts
readonly asof: {
  /** Right-side row count below which hash strategy is preferred over merge. */
  readonly mergeRowThreshold: number;
};
```

Default `10000`. Test escape hatch: tests force-enable merge by overriding
`asof.mergeRowThreshold` to `0` (or force-disable via `disabledRules`
including `'asof-strategy-select'`).

### `emitAsofScanMerge`

New emitter in `runtime/emit/asof-scan.ts`. Dispatched from `emitAsofScan`
based on `plan.strategy`:

```ts
export function emitAsofScan(plan, ctx) {
  return plan.strategy === 'merge'
    ? emitAsofScanMerge(plan, ctx)
    : emitAsofScanHash(plan, ctx);
}
```

Rename the existing body to `emitAsofScanHash` (private — the public name
stays `emitAsofScan`).

Co-streaming algorithm (`'desc'` direction; `'asc'` is symmetric):

```
buffered left iterator   leftIter   (peek-1)
buffered right iterator  rightIter  (peek-1)

while leftIter.hasNext():
  leftRow = leftIter.peek()

  // Skip left rows with NULL match or NULL partition (per current semantics).
  if leftRow.matchAttr is NULL or any partition val is NULL:
    yield padding or drop; consume leftRow; continue

  leftKey = partitionKey(leftRow)

  // Discard right rows from earlier partitions (no left consumer) and
  // right rows with NULL match/partition (filter).
  while rightIter.hasNext():
    rightRow = rightIter.peek()
    if rightRow.matchAttr is NULL or partition NULL: consume; continue
    cmp = comparePartitionKey(rightKey, leftKey)
    if cmp < 0: consume; continue        // right's partition is behind
    break

  // No more right rows OR right is on a later partition → no match.
  if !rightIter.hasNext() or comparePartitionKey(rightKey, leftKey) > 0:
    yield padding or drop; consume leftRow; continue

  // Same partition. Inner per-partition merge.
  // 'desc' (latest right ≤ left.match): keep advancing while next-right's
  // partition is still equal AND next-right.match qualifies (≤ or <).
  // The cursor sits on the last qualifying row.
  matched = undefined
  while rightIter.hasNext():
    rightRow = rightIter.peek()
    if rightRow.matchAttr is NULL or partition NULL: consume; continue
    if comparePartitionKey(rightKey, leftKey) != 0: break    // partition advanced
    cmp = compareMatch(rightRow.matchAttr, leftRow.matchAttr)
    qualifies = strict ? cmp < 0 : cmp <= 0
    if !qualifies: break
    matched = rightRow
    consume rightRow
  emit (leftRow, projectedRight(matched)) or padding-or-drop; consume leftRow

  // For consecutive left rows in the same partition with non-decreasing
  // matchAttr, the inner loop continues from where matched left it (cursor
  // does not regress within a partition — guaranteed by the
  // monotonicOn(left.matchAttr) requirement that the recognition rule already
  // enforces).
```

Important details:

- The cursor invariant **across consecutive left rows in the same partition**
  is the same as the hash strategy's per-bucket cursor. The recognition rule
  already requires `left.physical.monotonicOn(matchAttr)`, which prevents
  regressing left match values; the merge variant additionally relies on
  partition-prefix ordering to avoid revisiting partitions.
- **`'asc'` direction (earliest right ≥ left.match)**: in the inner loop,
  consume right rows while `right.match` is *too small*
  (`strict ? <= : <`); when the loop exits, `peek()` (still on the same
  partition) is the first qualifier. We must **not** consume that peek — it
  belongs to subsequent left rows in this partition.
  Mirror image of the hash emitter's asc cursor.
- **Partition-key encoding**: reuse `serializeRowKey` only for *equality* of
  partition tuples is wasteful here; instead compare attribute-by-attribute
  with `compareSqlValuesFast` and the per-attr collation, mirroring how the
  ordering was established. This is also what `sortable-bytes`-friendly
  ordering implies: equality = `compare === 0`. Keep this in a small helper
  `comparePartitionTuples(leftRow, rightRow, leftIdxs, rightIdxs, collations)`.
- **Buffered iterator helper**: introduce `peekableAsyncIterator(iter)` —
  thin wrapper providing `peek()`, `consume()`, `hasNext()`. Either local
  to `asof-scan.ts` (single use) or in `util/` if there's an existing
  pattern. Prefer local, file-scoped, until a second caller exists.

NULL semantics retained from the hash emitter:
- right NULL match → drop (filter on read)
- right NULL partition → drop
- left NULL match → padding (outer) or drop (inner)
- left NULL partition → padding (outer) or drop (inner)

### Cost model (optional follow-up nudge)

`AsofScanNode` already costs O(L + R). The strategy-select rule is a
predicate-driven rewrite (not enumerate-and-cost), so no cost-side change is
strictly required. If desired, slightly reduce the merge variant's cost
(e.g. `cost - smallEpsilon`) so a future cost-based picker prefers it; not
load-bearing for this ticket.

## Use cases

1. Trade-quote enrichment where both `trades` and `quotes` are pre-sorted by
   `(symbol, ts)` — no extra Sort needed; merge strategy streams.
2. Windowed-feature joins on a long table where the right side has millions
   of rows per partition — buffering would blow memory; merge stays O(1).
3. The threshold blocks merge for small right inputs where the hash variant
   already wins on constant factors.
4. Cases where left and right are NOT co-partition-ordered — selection rule
   bails, hash strategy continues as today.

## TODO

### Plan node

- Add `strategy: 'hash' | 'merge'` parameter to `AsofScanNode` constructor.
  Default to `'hash'` at the call site in `rule-lateral-top1-asof.ts` (no
  behavior change).
- Add `withStrategy(strategy: 'hash' | 'merge'): AsofScanNode` (returns
  `this` if unchanged; else a new node sharing all other state).
- Thread through `withChildren` (preserve the existing `strategy`).
- Include `strategy` in `toString()` (`ASOF SCAN [merge] on …`) and
  `getLogicalAttributes()`.

### Tuning

- Add `asof: { mergeRowThreshold: number }` to `OptimizerTuning` and
  `DEFAULT_TUNING` (`10000`).

### Selection rule

- New file `packages/quereus/src/planner/rules/access/rule-asof-strategy-select.ts`
  implementing the algorithm above. Unit-style logic: pure function on
  `(node, ctx)`; no async; bails to `null` on any check fail.
- Register in `optimizer.ts` under `PassId.PostOptimization`, phase `'impl'`,
  priority `11`, nodeType `PlanNodeType.AsofScan`.

### Emitter

- In `runtime/emit/asof-scan.ts`, rename current body to `emitAsofScanHash`,
  introduce `emitAsofScanMerge`, and dispatch from `emitAsofScan` on
  `plan.strategy`. Share the boilerplate (attr index resolution, projection,
  collation lookup, `joinOutputRow` use).
- Add a small `peekableAsyncIterator` helper at the bottom of the file.
- Add a `comparePartitionTuples` helper using `compareSqlValuesFast` over
  per-attr collations resolved at emitter setup. NULL in any partition slot
  is treated as filter-out (matches the hash emitter's `pk === null`
  behavior in `serializeRowKey`).

### Tests

Plan-shape (`packages/quereus/test/optimizer/asof-scan.spec.ts`):
- Default strategy is `'hash'`. Existing assertions still pass; add a new
  assertion that the recognized AsofScan reports `strategy: 'hash'`.
- New case: both inputs ordered by `(symbol, ts)` with both directions
  matching → strategy becomes `'merge'`. Construct via a memory-table whose
  PK is `(symbol, ts)` so the access-path advertises that ordering.
- New case: mismatched ordering (e.g., right is `(ts, symbol)` while left is
  `(symbol, ts)`) → stays `'hash'`.
- New case: `tuning.asof.mergeRowThreshold` set far above estimated right
  row count → stays `'hash'` even when ordering matches. (Use
  `Database.setOptimizerTuning(...)` or whichever path the optimizer-tuning
  tests already use.)
- New case: `disabledRules: new Set(['asof-strategy-select'])` → stays
  `'hash'`.

SQL-logic (`packages/quereus/test/logic/84-asof-scan.sqllogic`):
- Add an `--optimizer-tuning` block (or the existing pattern in this repo)
  forcing `asof.mergeRowThreshold = 0` so merge is always chosen for the
  pre-ordered fixture. Re-run a representative subset of the existing
  scenarios (partitioned non-strict, strict, ASC variant, outer empty
  partition, inner drop-on-no-match, boundary-tie). Expected outputs are
  identical to the hash variant — equivalence is the validation.
- Keep the existing scenarios as-is (they cover hash by default).

### Docs

- Update `docs/optimizer.md` AsofScan section with the strategy split,
  selection criteria, and tuning knob.

### Validation

- `yarn workspace @quereus/quereus run lint`
- `npx tsc --noEmit`
- `yarn test 2>&1 | tee /tmp/asof-merge-test.log; tail -n 80 /tmp/asof-merge-test.log`
- (Skip `yarn test:store` unless a store-specific issue surfaces.)
