---
description: Implement AsofScan plan node, hash-bucketed streaming emitter, and the lateral-top-1 → AsofScan recognition rule
prereq: monotonic-on-characteristic, bestaccessplan-monotonic-ordering
files: packages/quereus/src/planner/nodes/plan-node-type.ts, packages/quereus/src/planner/nodes/asof-scan-node.ts (new), packages/quereus/src/runtime/emit/asof-scan.ts (new), packages/quereus/src/runtime/emitters.ts, packages/quereus/src/planner/rules/join/rule-lateral-top1-asof.ts (new), packages/quereus/src/planner/optimizer.ts, packages/quereus/test/optimizer/asof-scan.spec.ts (new), packages/quereus/test/logic/asof-scan.sqllogic (new), docs/optimizer.md
---

## Architecture

The "asof join" — for each left row, the latest right row whose key is ≤ the left's
key, optionally per partition — is a recurring shape in time-series, financial, and
event-stream queries. Standard SQL writes it as a lateral-top-1 subquery:

```sql
select t.*, q.bid, q.ask
from trades t
left join lateral (
  select bid, ask
  from quotes q
  where q.symbol = t.symbol and q.ts <= t.ts
  order by q.ts desc
  limit 1
) q on true;
```

Today this executes as the existing nested-loop / cached lateral path: per left row,
re-emit the right subtree, keep one row. Cost is `O(L · log R)` at best (assuming
the right has an index on `(symbol, ts)`); with no index it's `O(L · R)`.

When `q.ts` is `MonotonicOn` and the right access plan advertises
`accessCapabilities.asofRight` (companion ticket `1-bestaccessplan-monotonic-ordering`),
the work collapses to `O(L + R)` via a streaming pass — the goal of this ticket.

`LATERAL` is parsed but not stored on `JoinNode` (`packages/quereus/src/parser/parser.ts:1102`
discards `_isLateral`); a lateral-top-1 simply manifests as a regular `JoinNode`
whose right child is correlated (column references into the left attribute set).
The rule recognizes that shape; no parser changes.

### The plan node

```ts
// packages/quereus/src/planner/nodes/asof-scan-node.ts

export class AsofScanNode extends PlanNode implements BinaryRelationalNode {
  override readonly nodeType = PlanNodeType.AsofScan;

  constructor(
    scope: Scope,
    /** Left (driving) input */
    public readonly left: RelationalPlanNode,
    /** Right input — must advertise MonotonicOn(matchAttr.right) and accessCapabilities.asofRight */
    public readonly right: RelationalPlanNode,
    /** Asof attribute pair (left.match >= right.match) */
    public readonly matchAttr: { leftAttrId: number; rightAttrId: number },
    /** Equi-partition keys (zero or more). Empty array == single bucket. */
    public readonly partitionAttrs: readonly { leftAttrId: number; rightAttrId: number }[],
    /** Strict (<) vs non-strict (≤) on the asof comparison */
    public readonly strict: boolean,
    /** LEFT JOIN semantics: emit unmatched left rows with NULL right columns */
    public readonly outer: boolean,
    /**
     * Right-side projection: which right attributes appear in the output, in order.
     * Lets the rule pre-prune attributes the lateral subquery dropped.
     * If undefined, all right attributes are emitted (mirrors a JoinNode).
     */
    public readonly outputRightAttrIds?: readonly number[],
  ) {
    const leftRows = left.estimatedRows ?? 100;
    const rightRows = right.estimatedRows ?? 100;
    // O(L + R), with a small per-row hash lookup constant when partitioned.
    const cost = left.getTotalCost() + right.getTotalCost() + leftRows + rightRows;
    super(scope, cost);
  }

  // getType(): left columns ⊎ projected right columns; right columns become
  //   nullable when outer === true.
  // getAttributes(): left attrs ⊎ filtered right attrs (using outputRightAttrIds).
  // computePhysical: ordering inherits left's ordering; monotonicOn inherits left's
  //   monotonicOn entries that survive (strict-AND with whether left was strict on
  //   the match attr).
}
```

`AsofScan` is internal — the parser never produces it. The rule introduces it.

### Runtime semantics (hash-bucketed emitter)

The emitter buckets the right side by partition key once, then streams left rows
through:

```
buckets: Map<partitionKey, { rows: Row[], cursor: number }> = new Map()
for r in right_source:                               // single pass over right
  pk = partition_key(r)
  buckets.get_or_create(pk).rows.push(r)
// rows in each bucket are NOT re-sorted — they arrive in MonotonicOn order from
// the right access plan (verified at emit time; otherwise sort here as a fallback).

for l in left_source:
  pk = partition_key_left(l)
  bucket = buckets.get(pk)
  if not bucket:
    if outer: emit(l + NULL_right)
    continue
  // Advance bucket.cursor while next row's match_attr <= l.match_attr (or < if strict).
  while bucket.cursor + 1 < bucket.rows.length
        and cmp(bucket.rows[bucket.cursor + 1].match, l.match) advances:
    bucket.cursor += 1
  // Boundary: if cursor row's match doesn't satisfy the predicate w.r.t. l, no match.
  candidate = bucket.rows[bucket.cursor] if bucket.cursor < bucket.rows.length else null
  if candidate and (candidate.match < l.match) or (not strict and candidate.match <= l.match):
    emit(l + project(candidate, outputRightAttrIds))
  elif outer:
    emit(l + NULL_right)
```

Trade-off: O(R) right buffering by partition. Acceptable for the first pass and
correct for both unpartitioned (single bucket) and partitioned cases. The
co-streaming alternative — outer-merge by partition key + inner-merge by match —
saves the right-side buffer when both inputs are co-partitioned in the same key
order, and is parked in a backlog ticket for cost-model-driven selection.

Edge cases the emitter must honor:
- **Strict vs non-strict**: drives the `<` vs `≤` choice in the advance/match
  boundary check.
- **Per-bucket independent cursors**: each partition advances independently; the
  left input is not required to be co-partitioned with the right.
- **Left input that's NOT match-ordered within partition**: cursor cannot regress.
  The rule asserts left is ordered on the match attribute (per partition) before
  firing; if left's ordering doesn't cover that, the rule does not fire (or
  inserts a `Sort` if the cost model favors it — deferred for the first pass).
- **NULL match values**: SQL three-valued logic excludes them. Skip left rows
  with NULL match (emit NULL-padded if `outer`); skip right rows with NULL match
  during bucketing.
- **NULL partition values**: behave as a distinct partition (matching equi-join
  NULL semantics — never match other NULLs). Implementation: use a sentinel or
  `null` literal as the bucket key, and exclude such buckets from cross-bucket
  matching.

### The rule

Pattern (structurally):

```
JoinNode (joinType ∈ {inner, left})
  left:  Left
  right: Project (q.* subset)
            └─ LimitOffsetNode (limit = const 1, offset = none)
                 └─ SortNode (single key: q.K, direction = desc)
                      └─ FilterNode (ANDed: (q.K op left.K) AND (q.P_i = left.P_i)*)
                              └─ Right                       // any relation; stripped of the sort/filter when planted under AsofScan
```

`op` is `<` (strict) or `<=` (non-strict). The rule:

1. Verifies the right side is correlated against the left (uses
   `cache/correlation-detector.ts:isCorrelatedSubquery`).
2. Walks the right subtree to peel `Project / LimitOffset(1) / Sort([K desc])`.
3. Splits the inner `FilterNode` predicate into conjuncts; classifies each as:
   - `q.K op left.K` (the asof inequality) — exactly one expected;
   - `q.P_i = left.P_j` (partition equality) — zero or more;
   - anything else — bail (rule does not fire).
4. Resolves attribute IDs for `K` on both sides and each partition pair.
5. Verifies the right's chosen access plan exposes `monotonicOn(K)` and
   `accessCapabilities.asofRight` on its physical leaf (from
   `1-bestaccessplan-monotonic-ordering`). If not, bail.
6. Verifies `LIMIT 1` is a constant `1` (no parameter / non-1 limit / offset).
7. Verifies the lateral's `Sort` is on `q.K desc` only. ASC variant
   (`q.K >= left.K` order asc limit 1) is symmetric; deferred to a follow-up.
8. Verifies left is ordered on `K` (and grouped/ordered by partition keys when
   non-empty). If not, the rule does not fire (insertion of a `Sort` is a
   cost-model decision deferred to follow-up).
9. Builds `AsofScanNode` with the extracted parameters and replaces the
   JoinNode.

Captures `outer = (joinType === 'left')`. Inner JOIN LATERAL → `outer = false`.

The rule must not fire when:
- The lateral references columns the rule cannot map to the asof shape (e.g.
  inequalities on multiple right columns, additional non-equality non-asof
  predicates, computed sort keys).
- The right's access plan lacks `accessCapabilities.asofRight`.
- The lateral's `Project` re-projects right columns through non-trivial
  expressions (a follow-up could lift trivial column references; defer).
- `LIMIT n` for `n ≠ 1` or `OFFSET ≠ 0`.

When the rule does not fire, the existing nested-loop lateral path executes
unchanged.

### Plan-node properties

- `getAttributes()`: left attrs ⊎ projected right attrs. Right attrs marked
  nullable when `outer = true` (consistent with `JoinNode` / `MergeJoinNode`).
- `getType()`: derived likewise; reuses
  `join-utils.ts:buildJoinRelationType` with `joinType: outer ? 'left' : 'inner'`.
- `physical.ordering`: inherits left's.
- `physical.monotonicOn`: inherits left's monotonicOn entries (the asof
  scan is left-driven; it preserves left's order).
- `physical.estimatedRows`: ≈ left's row count (the scan is one row in, ≤ one
  row out).
- `physical.uniqueKeys`: drops (right values may make per-left-row outputs
  non-unique on left's keys).

### Registration

Register the rule in `packages/quereus/src/planner/optimizer.ts` in the
`Physical` pass, post `select-access-path` (so the right's
`accessCapabilities.asofRight` is already lifted onto its leaf). `nodeType:
PlanNodeType.Join`. Priority: between `quickpick-join-enumeration` (5) and
`aggregate-physical` (20) — pick `15`.

### Documentation

Update `docs/optimizer.md` § "Streaming asof scan" (new section) describing the
lateral-top-1 idiom that's recognized, the required vtab capabilities, and the
fall-through behavior.

### Tests

#### Plan-shape tests (`test/optimizer/asof-scan.spec.ts`)

Use `query_plan(sql)` to confirm the rule fires (or doesn't) and that
`AsofScanNode` carries the expected fields:

- **Positive — unpartitioned**:
  ```sql
  select t.id, q.v from t left join lateral (
    select v from q where q.k <= t.k order by q.k desc limit 1
  ) q on true
  ```
  Expects `ASOF SCAN` op in the plan, `outer = true`, `partitionAttrs.length = 0`,
  `strict = false`.

- **Positive — partitioned**:
  ```sql
  select t.id, q.v from t left join lateral (
    select v from q where q.p = t.p and q.k <= t.k order by q.k desc limit 1
  ) q on true
  ```
  Expects `ASOF SCAN`, `partitionAttrs.length = 1`, partition pair resolves to
  `t.p` ↔ `q.p`.

- **Positive — strict**:
  Same as above but `q.k < t.k` ⇒ `strict = true`.

- **Positive — inner join**:
  Use `inner join lateral` (or `cross join lateral` with `on true`) ⇒ `outer = false`.

- **Negative — right lacks `accessCapabilities.asofRight`**:
  Build a custom test vtab whose `findBestAccessPlan` does NOT advertise
  `asofRight`, or use a query whose right side is forced through a path that
  doesn't expose it (e.g. a vtab without monotonicOn). Plan should remain a
  `Join` (`NestedLoopJoin` or whichever the existing physical selection picks).

- **Negative — multiple inequalities**:
  `where q.k <= t.k and q.k >= t.k_lo` — the rule must not fire.

- **Negative — `LIMIT 2`**: rule does not fire.

- **Negative — `LIMIT 1 OFFSET 1`**: rule does not fire.

- **Negative — non-trivial sort key** (`order by q.k + 1 desc limit 1`): rule
  does not fire.

- **Plan-node properties**: a positive case asserts `physical.ordering` /
  `physical.monotonicOn` propagate from left.

#### SQL-logic equivalence tests (`test/logic/asof-scan.sqllogic`)

Run identical queries with the rule forced on (default tuning) vs. forced off
(via `tuning.disabledRules.add('lateral-top1-asof')`) and compare result sets.
Cases:
- Empty right.
- All left rows match (right has rows for every left key).
- All left rows unmatched (left's match values precede every right row).
- Mixed match / unmatched with `left join lateral` (NULL-padding behavior).
- Strict vs non-strict on a tied boundary.
- Partitioned: left and right partitioned by the same key with disjoint
  partition values; cross-partition rows must not match.
- Right partitions with empty buckets (matching `outer` should NULL-pad).

### Out of scope (deferred)

- ASC variant (`q.k >= t.k order by q.k asc limit 1`) — symmetric, document and
  file a follow-up backlog ticket if not already present.
- The rule auto-inserting a `Sort` on left when its ordering doesn't match the
  asof attribute. For the first pass, the rule simply does not fire; users get
  the existing nested-loop lateral path.
- Cost-model-driven selection between hash-bucketed and merge-by-partition-key
  emitter strategies — see backlog ticket `asof-scan-merge-by-partition-key`.
- Recognizing the lateral when the lateral's outer `Project` lifts a
  non-trivial expression of right columns.

## TODO

### Phase 1 — plan node

- Add `AsofScan = 'AsofScan'` to `PlanNodeType` (`plan-node-type.ts`).
- Create `planner/nodes/asof-scan-node.ts` implementing `AsofScanNode` per
  the architecture above. Implement `getAttributes`, `getType` (via
  `buildJoinRelationType`), `getChildren` (returns `[left, right]`),
  `getRelations`, `withChildren`, `computePhysical`, `estimatedRows`,
  `toString`, `getLogicalAttributes`. Cache attributes via `Cached`.
- Mirror the `MergeJoinNode` shape for residual-free joins (no `condition`
  child; the asof predicate is encoded in `matchAttr`/`strict`).

### Phase 2 — emitter (hash-bucketed)

- Create `runtime/emit/asof-scan.ts` exporting `emitAsofScan(plan, ctx): Instruction`.
  Implementation pattern mirrors `runtime/emit/merge-join.ts` for left/right slot
  setup and `joinOutputRow` for NULL-padding the outer case.
  - Pre-resolve `matchAttr.{leftAttrId,rightAttrId}` to column indices.
  - Pre-resolve each `partitionAttrs` pair to `{leftIdx, rightIdx, collation}`.
  - Pre-resolve `outputRightAttrIds` to right column indices used for
    projection (`right_idx_to_emit: number[]`); when undefined, emit all right
    columns.
  - In `run`: bucket right rows by partition key (string-encoded composite
    using `compareSqlValuesFast` collations), preserving emit order. Then
    stream left, advance the bucket cursor, and emit per the runtime
    semantics.
  - Use `joinOutputRow(outer ? 'left' : 'inner', matched, false, leftRow,
    rightColCount, rightSlot)` to maintain consistency with existing join
    NULL-padding.
- Wire the emitter into `runtime/emitters.ts` so `emitPlanNode` dispatches
  `PlanNodeType.AsofScan` to `emitAsofScan`.

### Phase 3 — recognition rule

- Create `planner/rules/join/rule-lateral-top1-asof.ts` exporting
  `ruleLateralTop1Asof(node, ctx)`. Implementation skeleton:
  - Bail early if `node.nodeType !== PlanNodeType.Join` or
    `node.joinType !∈ {'inner','left','cross'}`.
  - Use `isCorrelatedSubquery(node.right)` from `correlation-detector.ts`.
  - Peel `Project` (only when columns are trivial `ColumnReference`s),
    `LimitOffsetNode` (limit must be constant `1`, no offset), `SortNode`
    (must be single key, `desc`, trivial column reference).
  - Split the inner `FilterNode` predicate; classify conjuncts as asof /
    partition-eq / other (other ⇒ bail).
  - Resolve attribute IDs and inspect right's physical leaf (walk to the
    bottom physical leaf — `IndexScanNode`/`IndexSeekNode` — and check
    `physical.monotonicOn` and `physical.accessCapabilities?.asofRight`).
    Bail if either missing.
  - Build `AsofScanNode`. Right input is the lateral subtree with the asof
    predicate's K-inequality stripped (the partition equalities can stay or
    can be stripped — semantically the asof emitter applies them via partition
    keys, so strip them to avoid redundant filtering).
  - Return the new node; otherwise return `null`.
- Register in `optimizer.ts` `registerRulesToPasses` under the `Physical` pass,
  `nodeType: PlanNodeType.Join`, `phase: 'impl'`, `priority: 15`. Place after
  `select-access-path` and before `aggregate-physical`.

### Phase 4 — tests + docs

- Add `test/optimizer/asof-scan.spec.ts` with the plan-shape cases listed
  above, using `query_plan()` JSON to inspect `AsofScan` properties.
- Add `test/logic/asof-scan.sqllogic` with equivalence cases (rule on vs. off).
  Use the Memory-table module — its `findBestAccessPlan` already advertises
  `supportsAsofRight` (`1-bestaccessplan-monotonic-ordering` complete ticket).
- Update `docs/optimizer.md` with a "Streaming asof scan" section: the
  recognized lateral idiom, the required vtab capabilities, and the rule's
  bail conditions.

### Validation

- `yarn workspace @quereus/quereus exec tsc --noEmit` clean.
- `yarn workspace @quereus/quereus lint` clean.
- `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/asof-test.log` — full
  suite passes; new tests included.
- `yarn build` — full repo green.
