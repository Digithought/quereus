---
description: Review of streaming AsofScanNode + lateral-top-1 recognition rule
files:
  - packages/quereus/src/planner/nodes/plan-node-type.ts
  - packages/quereus/src/planner/nodes/asof-scan-node.ts (new)
  - packages/quereus/src/runtime/emit/asof-scan.ts (new)
  - packages/quereus/src/runtime/register.ts
  - packages/quereus/src/planner/rules/join/rule-lateral-top1-asof.ts (new)
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/src/parser/ast.ts
  - packages/quereus/src/parser/parser.ts
  - packages/quereus/src/planner/building/select.ts
  - packages/quereus/test/optimizer/asof-scan.spec.ts (new)
  - packages/quereus/test/logic/84-asof-scan.sqllogic (new)
  - docs/optimizer.md
---

## What was built

A streaming asof-scan path for time-series and event-stream queries that
collapses the lateral-top-1 idiom — `LEFT JOIN LATERAL (... LIMIT 1)` — from
`O(L · log R)` to `O(L + R)`.

### New plan node — `AsofScanNode`

`packages/quereus/src/planner/nodes/asof-scan-node.ts`

A `BinaryRelationalNode` modeled after `MergeJoinNode`: takes a left input,
a right input that advertises `monotonicOn(matchAttr)` and
`accessCapabilities.asofRight`, an asof attribute pair, optional partition
attribute pairs, a `strict` flag, and an `outer` flag. Output attributes
are `left ⊎ projected_right`, with the right side's attribute IDs
preserved from the original logical `JoinNode` (via
`rightOutputColumnIndices` + `rightOutputAttrs`) so the parent of the join
keeps seeing identical IDs after rewrite.

`computePhysical` propagates the left's `ordering` and `monotonicOn` (the
asof scan is left-driven and emits one row per left row in left's order).
Drops `uniqueKeys` (right values appended per left row don't preserve
uniqueness on left's keys).

### New runtime emitter — `emitAsofScan`

`packages/quereus/src/runtime/emit/asof-scan.ts`

Hash-bucketed streaming algorithm:

1. Bucket the right input by partition key (string-encoded composite, single
   `''` bucket when no partition). Drops right rows with NULL match values
   or NULL partition values.
2. For each left row: look up its partition's bucket; advance the bucket's
   cursor while the next row's match still satisfies the asof predicate
   (`<= left.match` non-strict, `< left.match` strict). Emit
   `(leftRow, projected_right)` when the cursor matches; else NULL-pad
   (outer) or drop (inner).

Per-bucket cursors are maintained independently so left rows for different
partitions interleave freely. The cursor cannot regress, which is why the
rule requires the left to be `monotonicOn(matchAttr)`.

### New recognition rule — `ruleLateralTop1Asof`

`packages/quereus/src/planner/rules/join/rule-lateral-top1-asof.ts`

Registered in the **Structural pass** at priority 5 (before
`predicate-pushdown` at 20, so the lateral's `FilterNode` carrying the
asof predicate is intact).

Pattern matched:
- `JoinNode (joinType ∈ {inner, left, cross}, condition absent or `true`)`
- right peeled through `Project | LimitOffset | Sort | Alias`
- `LimitOffset.limit = 1`, no offset
- `Sort` is single descending column reference
- `Filter` predicate is AND of `(q.K op left.K)` (the asof inequality) and
  zero or more `(q.P_i = left.P_i)` (partition equalities)

Bail conditions:
- No correlation (`isCorrelatedSubquery(node.right)` returns false)
- Multiple inequalities, non-trivial sort key, non-trivial projection,
  `LIMIT n ≠ 1`, `OFFSET ≠ 0`
- Right's underlying `TableReference` does not advertise
  `supportsAsofRight + monotonicOn(K)` via its vtab module's
  `getBestAccessPlan`
- Left does not have `physical.monotonicOn(matchAttr)`

When the rule does not fire, the existing nested-loop / cached-lateral path
runs unchanged.

### LATERAL parser support

The ticket noted that the `_isLateral` flag was being discarded
(`packages/quereus/src/parser/parser.ts:1102`). Without LATERAL semantics,
the lateral subquery's right-hand side cannot reference outer columns,
which is the prerequisite for the asof rule to fire.

Minimal LATERAL plumbing was added:
- `AST.JoinClause.isLateral?: boolean` (`packages/quereus/src/parser/ast.ts:380-388`)
- Parser captures the flag (`packages/quereus/src/parser/parser.ts:1102`,
  populated into the AST literal at the bottom of the function).
- `buildJoin` (`packages/quereus/src/planner/building/select.ts:558-580`)
  extends the right's build context with a `ShadowScope([leftScope, ...])`
  when `joinClause.isLateral` is true, allowing the inner subquery's
  references to resolve outer columns.

### Tests

- **`packages/quereus/test/optimizer/asof-scan.spec.ts`** — 10 plan-shape
  cases:
  - Positive: unpartitioned, partitioned, strict, inner cross-join.
  - Negative: `LIMIT 2`, `LIMIT 1 OFFSET 1`, non-trivial sort key,
    multiple inequalities.
  - Properties: `physical.ordering` inherits from left; rule disabled via
    `tuning.disabledRules.add('lateral-top1-asof')` falls back to the
    join path.

- **`packages/quereus/test/logic/84-asof-scan.sqllogic`** — end-to-end
  correctness through the runtime emitter:
  - Plan-shape sentinel (`ASOFSCAN` op present in `query_plan`).
  - Partitioned non-strict left lateral (mixed match / no-match).
  - Inner cross-join lateral (drops unmatched).
  - Strict variant (`q.ts < t.ts`).
  - Boundary tie (non-strict matches the tie; strict skips it).
  - Empty right (NULL-padded under outer; dropped under inner).
  - Unpartitioned asof.

### Docs

`docs/optimizer.md`:
- New section "Streaming asof scan" describing the recognized idiom,
  required vtab capabilities, required left ordering, and bail conditions.
- New entry under "Optimization Rules → Join" pointing at the new rule.

## Use cases for review

1. **Trade enrichment**: the canonical asof query — for each trade, attach
   the latest quote at or before the trade time.
   ```sql
   select t.*, q.bid, q.ask
   from (select * from trades order by ts) t
   left join lateral (
     select bid, ask from quotes q
     where q.symbol = t.symbol and q.ts <= t.ts
     order by q.ts desc limit 1
   ) q on true;
   ```
2. **Strict asof**: drop the equality boundary (`q.ts < t.ts`).
3. **Unpartitioned asof**: no partition equi-pair; whole right is one
   bucket.
4. **Inner cross-join lateral**: drops left rows with no match (vs.
   left-join lateral which NULL-pads).

## Validation

- `npx tsc --noEmit` (packages/quereus) — clean.
- `yarn lint` (packages/quereus) — clean.
- `yarn test` (packages/quereus) — 2566 passing, 2 pending (unchanged).
- `yarn build` (repo) — clean.

## Out-of-scope / deferred

- ASC variant (`q.K >= left.K order by q.K asc limit 1`) — symmetric to
  the DESC form recognized here. Worth a follow-up backlog ticket.
- Auto-inserting a `Sort` on the left when its ordering doesn't match the
  asof attribute — currently the rule simply does not fire.
- Cost-model-driven selection between hash-bucketed and merge-by-partition
  emitters — the hash-bucketed strategy is unconditional for now (the
  merge-by-partition variant was already deferred to a backlog ticket per
  the original implement ticket).
- Recognizing the lateral when the outer `Project` lifts a non-trivial
  expression of right columns — the rule today bails for any non-trivial
  projection.

## Reviewer focus areas

- Attribute-ID preservation: the rule plants `Filter.source` as the right
  child of the new `AsofScanNode` (which has the underlying Retrieve's
  IDs), then exposes the original `JoinNode.getAttributes()` IDs via
  `rightOutputAttrs`. Trivial column-reference projections preserve IDs in
  Quereus's `ProjectNode` (so the rebuilding works), but please verify
  there isn't a non-trivial path that still leaks an ID mismatch.
- The structural-pass placement (priority 5, before predicate-pushdown 20)
  is what keeps the `FilterNode` intact — confirm this doesn't conflict
  with other structural rules.
- The minimal LATERAL plumbing in `buildJoin` is the smallest change that
  makes correlation work (just inject the left's output scope into the
  right's build context for `isLateral` joins). It's worth a sanity check
  that this doesn't allow non-LATERAL `LEFT JOIN ... ON ...` patterns to
  inadvertently see outer columns.
- The hash-bucket key encoding (`buildPartitionKey`) uses a string of
  `${typeof v}:${String(v)}` joined with spaces — equivalent to a
  composite-equality key under SQLite's type-coercion-free comparison.
  For the memory module's plain values this is fine, but worth a glance
  for collation/typed equality concerns.
