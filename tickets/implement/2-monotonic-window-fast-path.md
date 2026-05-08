---
description: Streaming fast paths for window functions over a MonotonicOn input — ranking functions, LAG/LEAD, and UNBOUNDED PRECEDING TO CURRENT ROW running aggregates. Plan-level recognition rule + runtime streaming emitter dispatched from the existing WindowNode via a `streaming` flag.
files: packages/quereus/src/planner/nodes/window-node.ts, packages/quereus/src/planner/rules/window/rule-monotonic-window.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/runtime/emit/window.ts, packages/quereus/src/schema/window-function.ts, packages/quereus/test/optimizer/monotonic-window.spec.ts, packages/quereus/test/logic/07.5-window.sqllogic, docs/window-functions.md, docs/optimizer.md

---

## Architecture

The existing `WindowNode` + `emitWindow` always materializes the source into `allRows`, groups into a partition map, sorts each partition by `ORDER BY`, then walks each sorted partition computing per-row values. When the source already streams rows in `[PARTITION BY..., ORDER BY]` order — i.e. its `physical.monotonicOn` covers the window's leading ORDER BY key and the partition keys are an emit-order-aligned prefix — the buffer/sort is wasted: the same answer is computable in one streaming pass with `O(P)` per-partition state.

This ticket installs the recognition rule and the streaming runtime for the cheapest, highest-value subset:

| Function class | First-pass scope | Per-partition state |
| --- | --- | --- |
| Ranking: `ROW_NUMBER`, `RANK`, `DENSE_RANK` | yes | counter + last-key |
| Navigation: `LAG`, `LEAD` (literal offset) | yes | ring buffer of size `n` |
| Running aggregates: `SUM`, `COUNT`, `AVG`, `MIN`, `MAX` over `UNBOUNDED PRECEDING TO CURRENT ROW` (default frame when ORDER BY is present) | yes | accumulator |
| `NTILE`, `PERCENT_RANK`, `CUME_DIST` | **deferred** — need partition size up-front, not streaming-friendly without two passes |
| `FIRST_VALUE`, `LAST_VALUE` | partial — `FIRST_VALUE` is straightforward (cache first row of partition); `LAST_VALUE` with default frame returns the current row, so it's also trivial under `UNBOUNDED PRECEDING TO CURRENT ROW`. Include both. |
| Sliding frames (`ROWS BETWEEN n PRECEDING AND m FOLLOWING`, `RANGE` offsets) | **deferred** to a follow-up ticket |
| `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` (the default frame with ORDER BY) | yes — under streaming, peers all share the same ORDER BY value so the runtime emits the running-aggregate value at the *last peer*; we delay-emit at peer-group boundaries |

### Plan-layer change — flag on `WindowNode`

Adopt **Option A** from the plan ticket: add an optional `streaming?: boolean` (and a sibling structured field — see below) to `WindowNode`. Default `undefined`/`false` means "use the existing buffered emitter" — every existing call site is unchanged.

```ts
// window-node.ts (additions)
export interface StreamingWindowConfig {
  /** Per-function streaming mode chosen by the rule. Indexed parallel to `functions`. */
  modes: ReadonlyArray<
    | { kind: 'rowNumber' }
    | { kind: 'rank' | 'denseRank' }
    | { kind: 'lag' | 'lead'; offset: number; defaultIsNull: boolean }
    | { kind: 'firstValue' }
    | { kind: 'lastValue' }            // valid under default-frame streaming
    | { kind: 'runningAgg' }            // SUM/COUNT/AVG/MIN/MAX with UNBOUNDED PRECEDING TO CURRENT ROW
  >;
}

class WindowNode {
  // ...
  public readonly streaming?: StreamingWindowConfig;
}
```

The rule fires only when **all** functions in a single `WindowNode` are individually recognized. Mixed nodes (e.g. one streaming-capable + one `NTILE`) fall back to the buffered path; a future improvement can split a WindowNode into two when the buffered subset is small enough.

`withChildren` must propagate `streaming` to the new instance.

### `computePhysical()` revision

The existing rule drops `monotonicOn` whenever PARTITION BY is non-empty because the buffered emitter groups in insertion order and sorts within each partition — losing source order globally. Under streaming, the runtime walks the source in source order and emits in source order, so source's `monotonicOn` survives end-to-end. Tighten to:

- `streaming` set → preserve source's `monotonicOn` unchanged (windowing is row-pass-through under streaming).
- `streaming` unset → existing rule (PARTITION BY non-empty drops; otherwise derive from leading ORDER BY).

### Recognition rule — `ruleMonotonicWindow`

`packages/quereus/src/planner/rules/window/rule-monotonic-window.ts`. Registered in `optimizer.ts` under `PassId.PostOptimization` at priority 6 (after `monotonic-merge-join@4` so child joins have already become MergeJoins and propagate `monotonicOn`; before `monotonic-limit-pushdown@8` for predictability — they don't conflict since they target different node types).

**Preconditions** (all must hold):

1. `node` is a `WindowNode` with `streaming` not yet set.
2. `windowSpec.orderBy.length >= 1` and the **leading** order key is a trivial `ColumnReferenceNode` whose `attributeId` matches a `physical.monotonicOn` entry on `node.source`, with the same direction.
   - Subsequent ORDER BY keys are required only as tie-breakers; for ranking/lag/lead/first_value, peer-group detection cares about all ORDER BY keys, but if the source isn't monotonic on them too we still get correctness as long as runtime peer-equality compares all sorted values from the source. **Constraint for v1**: require the *leading* key to match `monotonicOn` and require the source's emit order to also include any subsequent ORDER BY keys via its `physical.ordering` (i.e. the `ordering` prefix covers the full ORDER BY). This is the same guarantee the buffered path's sort would produce.
3. Partition alignment: either `partitionBy` is empty, or `node.source.physical.ordering` (or `monotonicOn` chain) shows that all partition-by columns are an **emit-order prefix** of the source ordering, with the leading ORDER BY key following them. Concretely: source ordering is `[P1, ..., Pk, X, ...]` lex, where `{P1..Pk}` equals the partition-by attrId set (any permutation; the rule reorders) and `X` is the leading ORDER BY key.
   - All partition-by expressions must be trivial `ColumnReferenceNode`s. (Computed partition keys defer to buffered.)
4. Every entry in `node.functions` is individually recognizable per the table above. Decode `LAG`/`LEAD` arguments via `tryExtractNumericLiteral` (already present in `emit/window.ts` — lift to a shared helper). Reject `LAG/LEAD` when the offset is not a non-negative integer literal, or when a non-NULL default value is present and we'd need to evaluate it on a row that hasn't streamed yet (LEAD with custom default still works — emit default once we know we're past partition end).
5. Frame for running aggregates is either absent (default = `RANGE UNBOUNDED PRECEDING TO CURRENT ROW` when ORDER BY is present) or explicitly that frame in either `ROWS` or `RANGE` mode. **Reject** any other frame for v1.
6. `isDistinct === false` for all aggregates (windowed DISTINCT not yet streaming-capable).

When all preconditions hold, return a clone of the `WindowNode` with `streaming = { modes: [...] }`. Use the existing `withChildren` pathway (or pass a fresh constructor invocation) so attribute IDs are preserved — the rewrite must NOT renumber output attributes (downstream column refs depend on stable IDs).

The rule returns `null` (no-op) for any failed precondition; the buffered path remains.

### Runtime — `emit/window.ts` dispatch + streaming emitter

`emitWindow` opens with the recognized streaming flag and dispatches:

```ts
if (plan.streaming) {
  return emitWindowStreaming(plan, ctx);
}
// existing buffered emitter unchanged
```

`emitWindowStreaming` is the new function. Key shape:

- Resolve the same callbacks (`partitionCallbacks`, `orderByCallbacks`, `functionArgCallbacks`) and the same `sourceSlot`.
- Maintain `currentPartitionKey: string | null`, `partitionState: PartitionState | null`. On partition-key change, finalize/flush state for the previous partition and reset.
- For RANGE-mode running aggregates with peer groups, buffer the current peer group's pending output rows (just the input row + accumulator-so-far snapshot would not suffice because we must emit the *post-peer-group* aggregate value at every peer row). Implementation: buffer pending output rows of the current peer group; when a non-peer or partition boundary arrives, finalize the aggregate-after-this-peer-group, fill in the missing value column for each buffered row, yield them, then reset peer buffer. Worst case state is the size of one peer group, which is the natural cost of `RANGE`.
   - For ROWS-mode `UNBOUNDED PRECEDING TO CURRENT ROW`, no peer buffering is needed: emit each row immediately with the post-step accumulator.
- For `LAG(expr, n)`: maintain a ring buffer of the last `n` evaluated `expr` values + a `default` slot; at each row, the lagged value is `buf[(i - n) mod n+1]` or default if not yet populated.
- For `LEAD(expr, n)`: hold back the most recent `n` rows; emit row `i - n` only when row `i` arrives. At partition end, emit the final `n` rows with `default`.
- For `FIRST_VALUE`: cache `expr` evaluated on the partition's first row; reuse for every subsequent row in that partition.
- For `LAST_VALUE` under default frame (== current row): just evaluate `expr` on the current row.
- For ranking: per-partition counters; `RANK` jumps to row index when peer key changes, `DENSE_RANK` increments by 1 on each key change.
- Per-partition state lifecycle is `O(P)` where `P` is the active partition count — but since we walk in partition order, only the **current** partition's state lives at any time, so it's `O(1)` for partition-aligned input. (We never see an old partition again.)
- Final flush after the source iterator ends: yield any pending peer-group buffer for the last partition; flush LEAD's tail with default values.

The peer-group buffering for RANGE is the most subtle piece. A cleaner alternative: under RANGE default frame, group rows on the fly into peer chunks; for each chunk apply step→accumulator once, then emit the chunk with the post-step accumulator value. This avoids tracking individual row partial states.

### Cost model

The streaming variant has:
- No sort (saves `O(N log N)` per partition).
- No materialization buffer (saves `O(N)` memory).
- O(1) per row per function (vs. O(framewidth) for buffered RANGE/ROWS).

`computePhysical()` for a streaming WindowNode should report a substantially lower `estimatedCost` than the buffered variant for non-trivial inputs. If the optimizer ever needs to choose between them via cost (it shouldn't — recognition is a hard rewrite), the cost model already prefers streaming naturally because it skips a sort.

For now: do not change `estimatedCost` arithmetic. The rule unconditionally rewrites buffered → streaming when preconditions hold (no cost competition).

### Composition with downstream rules

A streaming `WindowNode` preserves source `monotonicOn` (per the revised `computePhysical`). This means downstream rules (`monotonic-limit-pushdown`, `monotonic-merge-join`, `monotonic-range-access`) compose naturally with windowed outputs. Add a plan-shape test that asserts `LIMIT 5` over a streaming `RANK() OVER (ORDER BY id)` collapses into an `OrdinalSlice` on the underlying access leaf.

## Testing strategy

### Plan-shape tests (`test/optimizer/monotonic-window.spec.ts`)

- `windowSpec.streaming` is set when input is `MonotonicOn(id)` and `OVER (ORDER BY id)`.
- `streaming` is set when `PARTITION BY p ORDER BY id` and source ordering is `(p, id)` (PK on `(p, id)` or composite index).
- `streaming` is **not** set when:
  - leading ORDER BY key is not a column reference (e.g. `ORDER BY id+1`),
  - source's `monotonicOn` doesn't cover the leading key (e.g. plain heap with no PK),
  - PARTITION BY columns aren't an emit-order prefix,
  - any function in the node is `NTILE`/`PERCENT_RANK`/`CUME_DIST`,
  - frame is `ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING`.
- Streaming `WindowNode`'s `physical.monotonicOn` preserves the source's leading-key entry.
- Streaming `WindowNode` over an `IndexScan` with `accessCapabilities.asofRight` does **not** propagate that capability (it's leaf-only — verify the existing pass-through policy still holds).

### SQL logic tests (`test/logic/07.5-window.sqllogic` extensions)

For each function class:

- Run the existing query with the existing expected output. Add a parallel query that forces buffered (e.g. `ORDER BY id+0` to break the recognition) and assert identical output.
- New cases:
  - `LAG(amount, 2, -1) OVER (ORDER BY id)` — boundary-row default values.
  - `LEAD(amount, 1) OVER (PARTITION BY product ORDER BY id)` — partition-boundary correctness (last row of each partition emits NULL).
  - `SUM(amount) OVER (PARTITION BY product ORDER BY id)` (default RANGE frame, with peer ties on `id` impossible because `id` is PK — also add a case with ties on a non-unique key to exercise the peer-group buffering).
  - `MIN(amount) OVER (PARTITION BY product ORDER BY id ROWS UNBOUNDED PRECEDING)`.
  - Empty partition: `WHERE 1=0` filter — should yield zero rows, no errors.
  - Single-row partition.
  - All-NULL `expr` for `LAG` / running aggregates.

### Negative tests

A focused mocha spec that asserts `streaming` stays unset for the disqualifying cases listed above.

## Out-of-scope (deferred to follow-ups)

- Sliding frames (`ROWS BETWEEN n PRECEDING AND m FOLLOWING`, `RANGE` with offsets). Needs sliding-window machinery — deque for `MIN`/`MAX`, range-offset binary search for value frames. Park as `3-monotonic-window-sliding-frames.md` in `backlog/` if not already there.
- `NTILE`/`PERCENT_RANK`/`CUME_DIST` — require partition size; possible with a two-pass streaming variant (count then emit), but more complex than v1.
- `DISTINCT` aggregates inside windows.
- Splitting a `WindowNode` containing both streaming-capable and non-streaming functions into two stacked WindowNodes so the streaming subset still benefits.
- Composite `monotonicOn` prefix recognition (e.g. source MonotonicOn on `(p, id)` jointly).
- DESC streaming. The recognition rule already requires direction match; the runtime works either way once the source advertises DESC, but verify with at least one DESC test case before claiming support.

## Phasing

Single ticket — recognition + runtime + tests + docs land together. Sub-agents may be useful to parallelize:
- Sub-agent A: implement recognition rule + plan-shape tests.
- Sub-agent B: implement streaming emitter + SQL logic tests.
- Main agent: integration, `WindowNode.computePhysical` revision, docs.

## TODO

### Phase 1 — Plan-layer plumbing
- Extend `WindowNode` with `streaming?: StreamingWindowConfig` (define the discriminated union as in the architecture section). Wire through the constructor + `withChildren`.
- Update `WindowNode.computePhysical()`: when `streaming` is set, preserve source's `monotonicOn` unchanged (drop the existing PARTITION BY → drop branch). Keep the buffered branch untouched.
- Add `getLogicalAttributes()` entry for streaming so EXPLAIN surfaces it.

### Phase 2 — Recognition rule
- New file `src/planner/rules/window/rule-monotonic-window.ts`. Implement `ruleMonotonicWindow(node, ctx)` per the preconditions above.
- Helper: lift `tryExtractNumericLiteral` out of `runtime/emit/window.ts` into a shared util (or `nodes/window-node.ts`) since both the rule and the runtime need it.
- Helper: a partition-alignment check that compares the partition-by attrIds against `source.physical.ordering` prefix.
- Register the rule in `src/planner/optimizer.ts` under `PassId.PostOptimization` at priority 6, `nodeType: PlanNodeType.Window`, phase `'impl'`.

### Phase 3 — Streaming runtime
- In `src/runtime/emit/window.ts`, add `emitWindowStreaming(plan, ctx)` and dispatch from `emitWindow` based on `plan.streaming`.
- Implement per-mode helpers:
  - `runRanking` (ROW_NUMBER / RANK / DENSE_RANK) — single counter per partition, last-key comparator using existing `preResolvedEqualityComparators`.
  - `runLag` / `runLead` — ring buffer / read-ahead buffer of arg-evaluated values + default value.
  - `runFirstValue` / `runLastValue` — cache first row's expr / evaluate on current.
  - `runRunningAgg` — fold using the `WindowFunctionSchema.step`/`final` already registered for SUM/COUNT/AVG/MIN/MAX. RANGE-mode peer buffering as described.
- Per-partition state: a flat object reset on partition-key change; partition key serialized via the same `serializeKeyNullGrouping` helper the buffered path uses.
- Final flush after source iterator ends.

### Phase 4 — Tests
- New file `test/optimizer/monotonic-window.spec.ts` — plan-shape positive + negative cases as specified.
- Extend `test/logic/07.5-window.sqllogic` (or `27-window-edge-cases.sqllogic`) with the streaming-equivalence cases.
- Verify `yarn lint`, `yarn build`, `yarn test` all clean before handoff.

### Phase 5 — Docs
- `docs/window-functions.md` — add a "Streaming fast path over MonotonicOn" section listing recognized functions/frames and the preconditions.
- `docs/optimizer.md` — entry under PostOptimization rules referencing `rule-monotonic-window`.

### Phase 6 — Out-of-scope housekeeping
- If a sliding-frames follow-up isn't already in `backlog/`, drop a stub `3-monotonic-window-sliding-frames.md` summarizing the deferred work and pointing at this ticket's TODO list. Otherwise leave a TODO comment in the runtime helper that splits frame handling.
