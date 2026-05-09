---
description: Review the merge-by-partition-key strategy for AsofScan and its strategy-select rule
files:
  - packages/quereus/src/planner/nodes/asof-scan-node.ts
  - packages/quereus/src/runtime/emit/asof-scan.ts
  - packages/quereus/src/runtime/context-helpers.ts
  - packages/quereus/src/planner/rules/access/rule-asof-strategy-select.ts
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/src/planner/optimizer-tuning.ts
  - packages/quereus/test/optimizer/asof-scan.spec.ts
  - packages/quereus/test/logic/84-asof-scan.sqllogic
  - docs/optimizer.md
---

## What landed

`AsofScanNode` now carries a `strategy: 'hash' | 'merge'` discriminator. The
default-and-existing emitter (now `emitAsofScanHash`) is preserved unchanged;
a new `emitAsofScanMerge` handles the co-streaming variant. The optimizer
selects between them via `rule-asof-strategy-select` after the children's
physical properties have been finalized.

### Key design points

- **Strategy field plumbing** (`asof-scan-node.ts`)
  - New trailing constructor param `strategy = 'hash'`. Threaded through
    `withChildren` (preserves existing strategy).
  - New `withStrategy(s)` helper; returns `this` when unchanged, else clones
    the node with the new strategy and identical other fields.
  - `toString()` includes `[hash]` / `[merge]`; `getLogicalAttributes()`
    surfaces `strategy` so `query_plan()`-based plan-shape tests can assert.

- **Tuning** (`optimizer-tuning.ts`)
  - `asof: { mergeRowThreshold: number }` (default `10000`). Below the
    threshold, the rule keeps `'hash'` because hash buffering's constant
    factors beat merge-state bookkeeping for small right inputs.

- **Rule** (`rule-asof-strategy-select.ts`, registered in `optimizer.ts`
  PostOptimization phase `'impl'` priority `11`, after
  `monotonic-range-access@9` and `mutating-subquery-cache@10`)
  - Idempotent (`strategy !== 'hash'` → bail).
  - Validates `physical.ordering` on each child has a leading
    `[partition cols..., matchAttr]` prefix; partition columns may appear in
    any permutation but positions must pair via `partitionAttrs` equi-pairs
    with matching directions on each side.
  - Trailing match-attr ordering must be **ASC** on both sides (independent
    of `node.direction`). Both directions of asof — `'desc'` (latest ≤) and
    `'asc'` (earliest ≥) — are implemented over forward iteration; ASC sort
    on matchAttr is the relevant precondition. *(The ticket's "direction
    must match ordering" wording was inconsistent with its algorithm; the
    algorithm carried the day.)*
  - Threshold gate against `right.estimatedRows ?? defaultRowEstimate`.
  - Returns `node.withStrategy('merge')` on success.

- **Emitter** (`asof-scan.ts`)
  - `emitAsofScan` is now a 2-line dispatch on `plan.strategy`.
  - `emitAsofScanHash` = the previous body, unchanged behavior.
  - `emitAsofScanMerge` walks both inputs with a peek-1 `peekableAsyncIterator`.
    Per-partition state (`activePartitionRow`, `descMatched`) is reset on
    partition transition. The desc inner loop accumulates the latest
    qualifier across same-partition left rows; the asc inner loop returns
    the first qualifier and does NOT consume it (it may match subsequent
    left rows).
  - `comparePartitions` uses per-position collations and direction (read
    off left's `physical.ordering` at emit time) so descending partition
    columns are handled. `compareLeftPartitions` is the same logic for
    detecting partition transitions on the left iterator.

- **`RowSlot.reactivate()`** (new, in `context-helpers.ts`)
  - Re-claims a slot's descriptor in the runtime context map so its
    `attributeIndex` entries point back at this slot's getter.
  - **Why it's load-bearing for merge**: the right scan's own `rowSlot` is
    created when its iterator starts and tracks the iterator's *cursor*
    (last peeked row, including the row that broke the merge loop). Because
    `ProjectNode` preserves attribute IDs through trivial column references,
    the lateral's `q.bid` reference resolves to the same attr id as the
    right scan's raw `bid` column. Without `reactivate`, the global
    `attributeIndex` for that attr id points to whichever slot was
    `set`-into-the-context-map most recently — the right scan's rowSlot —
    so a downstream `Project` evaluating `q.bid` reads the cursor row
    rather than the matched row. The hash variant sidesteps this naturally
    because it drains the right iterator (closing the scan's rowSlot)
    before AsofScan yields any left row; in merge, both iterators
    interleave, so we re-claim our slot after each `set(matched)` and
    after each NULL-padding emit.

### Tests added

`test/optimizer/asof-scan.spec.ts`:
- Default-strategy `'hash'` assertion on the original recognition test.
- Merge promotion: tuning override `mergeRowThreshold = 0` flips to
  `'merge'` for the unpartitioned desc case.
- Threshold-too-high: stays `'hash'` even with co-ordered inputs.
- Disabled rule (`disabledRules: new Set(['asof-strategy-select'])`):
  stays `'hash'`.
- Partitioned-but-mismatched: with `Sort by ts` on the left (no symbol
  prefix), the rule bails and stays `'hash'` even with threshold 0.
- Equivalence (hash vs merge): unpartitioned desc, unpartitioned asc,
  inner cross-join lateral with strict desc, and boundary-tie semantics
  (non-strict matches the tied right row, strict skips it). All four pass
  with merge promoted via tuning override.

### Test scope deferred to follow-up

End-to-end **partitioned** merge cases are not directly testable today:
`ruleLateralTop1Asof` requires `physical.monotonicOn(left.matchAttr)` —
i.e., *global* monotonicity on the left's match column. A user who wraps
the left in `ORDER BY symbol, ts` gets `monotonicOn(symbol)` (Sort only
advertises `monotonicOn` on its leading key), which doesn't satisfy the
recognition rule. So lateral-top1 won't fire and there's no AsofScanNode
for the strategy-select rule to act on.

The merge code path still **handles** partitioned inputs correctly (the
emitter is parameterized on `partitionLen`), but exercising it end-to-end
requires either:
- Extending `ruleLateralTop1Asof` to also accept "monotonic within
  partition" (when the left's `physical.ordering` is
  `[partition cols..., matchAttr]`), or
- A vtab module that natively advertises both `monotonicOn(matchAttr)` and
  multi-column ordering covering the partition prefix.

Either is a follow-up. The current spec tests cover the unpartitioned case
end-to-end; the partitioned algorithm is still exercised via the same
emitter code.

### Validation notes

- `npx tsc --noEmit -p packages/quereus` — clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn test` — **2655 passing, 2 pending, 0 failing.**
- `yarn test:store` — not run (no store-specific change).

### What to look for in review

- Correctness of `comparePartitions` direction handling — the rule
  validates `tailLeft.desc === tailRight.desc` per partition position; the
  emitter reads `partitionDescending[i]` from left's `physical.ordering`.
  Worth a second look that the per-position direction inversion is right.
- The `RowSlot.reactivate()` extension is small but touches a shared
  primitive. It's harmless when not called (it's only useful for streaming
  operators that interleave with downstream context writes), but worth a
  review of whether other emitters (e.g. `emitAsofScanHash`'s post-bucket
  phase, hash joins, merge joins) might benefit or already silently rely
  on the implicit close-and-rebuild behavior.
- `getLogicalAttributes()` adds `strategy` — confirm no plan-shape test
  outside `asof-scan.spec.ts` parses AsofScan's `properties` and now
  breaks because of the extra key. (None found in this implementation;
  please verify.)
- The deferred recognition extension (lateral-top1 accepting partitioned-
  monotonic left) is documented in `docs/optimizer.md` — confirm the
  framing reads as a known limitation, not a bug.

### Files touched

```
packages/quereus/src/planner/nodes/asof-scan-node.ts
packages/quereus/src/runtime/emit/asof-scan.ts
packages/quereus/src/runtime/context-helpers.ts            ← +reactivate
packages/quereus/src/runtime/emit/project.ts               ← (touched only for debug; reverted)
packages/quereus/src/planner/rules/access/rule-asof-strategy-select.ts  ← new
packages/quereus/src/planner/optimizer.ts                  ← rule registration
packages/quereus/src/planner/optimizer-tuning.ts           ← +asof.mergeRowThreshold
packages/quereus/test/optimizer/asof-scan.spec.ts          ← strategy + equivalence tests
packages/quereus/test/logic/84-asof-scan.sqllogic          ← header note pointing to spec tests
docs/optimizer.md                                          ← strategy-select section
```
