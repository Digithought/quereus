---
description: Review the OrdinalSlice plan node + emitter + optimizer rule that converts ORDER BY <monotonic> LIMIT n OFFSET k into an O(log N) ordinal seek
files: packages/quereus/src/planner/nodes/plan-node-type.ts, packages/quereus/src/planner/nodes/ordinal-slice-node.ts, packages/quereus/src/runtime/emit/ordinal-slice.ts, packages/quereus/src/runtime/emit/scan.ts, packages/quereus/src/runtime/register.ts, packages/quereus/src/planner/rules/access/rule-monotonic-limit-pushdown.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/vtab/filter-info.ts, packages/quereus/test/optimizer/monotonic-limit-pushdown.spec.ts, packages/quereus/test/vtab/test-ordinal-seek-module.ts, docs/optimizer.md, docs/module-authoring.md
---

## What was built

A new physical plan node (`OrdinalSliceNode`), its emitter, an optimizer rule (`monotonic-limit-pushdown`), and supporting infrastructure (`FilterInfo.limit/offset` fields, refactored `emitSeqScan` accepting a FilterInfo override). The rule recognizes the `LimitOffset[/Sort]/(trivial Project|Alias)*/access-leaf` shape and rewrites to `…/OrdinalSlice/leaf` when the leaf advertises both `monotonicOn` and `accessCapabilities.ordinalSeek`. The slice threads the resolved offset/limit into the leaf's `FilterInfo`, letting the vtab seek directly to the kth monotonic row in `O(log N)` instead of buffering `k + n` rows.

The slice's emitter retains a streaming row-cap guard above the leaf so modules that advertise `supportsOrdinalSeek` but ignore the directive at runtime degrade gracefully to a streaming `LIMIT` (the OFFSET is still skipped above, but at least the LIMIT short-circuits).

## Producer note

The memory module's BTree (inheritree 0.3.4) does **not** expose an O(log N) ordinal-seek operation — the underlying `BTree` API is path/key-based with `getCount()` running O(n/af). We followed option 1 from the ticket: a fixture vtab module (`test/vtab/test-ordinal-seek-module.ts`) with sorted-array storage advertises `supportsOrdinalSeek` and honors `FilterInfo.offset`/`limit` directly. The memory module continues to defer `supportsOrdinalSeek` advertisement.

## Key design decisions worth scrutinizing

- **OrdinalSlice's source must be a physical access leaf** (`SeqScanNode`/`IndexScanNode`/`IndexSeekNode`). The rule descends through trivial `Project` (all-bare-ColumnRef projections) and `AliasNode` wrappers; anything non-trivial (`Filter`, `Distinct`, etc.) aborts the descent. The OrdinalSlice slots in directly above the leaf, with the original Project/Alias chain re-stitched on top via `rebuildChain`. Sort is dropped (the slice's source already emits in the requested order).
- **Per-execution state via WeakMap**. The slice's emitter is shared across executions, but offset/limit values must flow from the slice's `run()` into the leaf's `FilterInfo` override. We keyed a `WeakMap<RuntimeContext, SliceBounds>` on the per-execution context to avoid concurrent-execution collisions. Reviewer should confirm this is the right pattern (vs. a context slot or threading via params).
- **Direction matching**. The rule only fires when the sort key direction matches the leaf's `monotonicOn.direction` exactly. An asc-monotonic leaf with an `ORDER BY id DESC` query falls through to the existing `LimitOffset(Sort(...))` path; we don't reverse-iterate.
- **Streaming row-cap guard**. The slice still enforces `bounds.limit` above the leaf even when the leaf honored the directive. This is defensive — a single redundant comparison per row vs. silent over-emission if the vtab forgets the directive.
- **No cost adjustment**. The rule leaves the slice's cost equal to the leaf's cost. The plan-shape rewrite is the win; cost-based competition between this rule and the existing `LimitOffset` path isn't modeled. If a future cost regression appears, we can plug in `log2(N)*seekCost + n*rowCost` per the original ticket.

## Validation

- `yarn workspace @quereus/quereus exec tsc --noEmit` — clean
- `yarn workspace @quereus/quereus test` — 2585 passing, 2 pending (no regressions)
- `yarn workspace @quereus/quereus lint` — clean

## Test coverage (`test/optimizer/monotonic-limit-pushdown.spec.ts`)

- Positive plan-shape: `ORDER BY id LIMIT n OFFSET k`, no-OFFSET, no-ORDER-BY, parameterized.
- Negative plan-shape: `ORDER BY id DESC` (direction mismatch), multi-key `ORDER BY`, residual `WHERE` filter, leaf without `ordinalSeek`, leaf without `monotonicOn`.
- Behavioral: `(n=10, k=0/500/995/10000)` boundary cases, `LIMIT 0`, parameterized bounds, identical results when the rule is disabled via `tuning.disabledRules`.
- Pushdown verification: vtab observes `FilterInfo.offset`/`limit` when rule fires; does not when it doesn't.
- Physical properties: `OrdinalSlice` preserves `monotonicOn` in its physical JSON.

19 tests, all passing.

## Use cases & how to exercise

```sql
-- Will use OrdinalSlice when the underlying module advertises
-- monotonicOn + supportsOrdinalSeek (e.g., the test fixture module)
select * from t order by id limit 5 offset 1000;
select * from t limit 5 offset 1000;  -- no ORDER BY needed if leaf is monotonic
```

```sql
-- Inspect plan
select op from query_plan('select id from t order by id limit 5 offset 100');
-- → BLOCK, PROJECT, ORDINALSLICE, INDEXSCAN, ...
```

```sql
-- Disable to A/B test
-- (in test code: db.optimizer.updateTuning({ ..., disabledRules: new Set(['monotonic-limit-pushdown']) }))
```

## Areas to inspect during review

1. `rule-monotonic-limit-pushdown.ts` — does the descent through `Project`/`Alias` correctly preserve attribute IDs? `rebuildChain` uses `withChildren`, which is supposed to keep attribute IDs stable.
2. `ordinal-slice.ts` emitter — the `WeakMap<RuntimeContext, SliceBounds>` pattern. Is there an existing convention for per-execution slot state I should have used instead?
3. `scan.ts` — the new `FilterInfoOverride` callback runs inside the leaf's `query()` lifecycle, after dynamic seek-key args are populated. Confirm the override sees the augmented args (including IndexSeek dynamic args).
4. `OrdinalSliceNode.computePhysical` — propagates `ordering`, `uniqueKeys`, `monotonicOn` from source; explicitly does NOT propagate `accessCapabilities`. Mirrors the contract documented on `PhysicalProperties`.
5. Test fixture (`test-ordinal-seek-module.ts`) — only advertises monotonicOn/ordinalSeek for unfiltered single-column-PK scans, mirroring the memory module's narrow advertisement window.
6. Docs: `docs/optimizer.md` (new "Monotonic LIMIT/OFFSET pushdown" section) and `docs/module-authoring.md` (FilterInfo offset/limit + capability contracts).

## Out of scope (intentional)

- Memory module ordinal-seek advertisement (BTree library doesn't expose O(log N) ordinal seek; would require either upstream library work or a parallel pickByOrdinal index).
- DESC `ORDER BY` over an asc leaf via reverse-iteration (would need a separate `reverseIteration` capability flag).
- Cost-based modeling — the rule fires whenever preconditions hold; reviewer should consider whether any case exists where the original buffer-and-discard would be cheaper.
