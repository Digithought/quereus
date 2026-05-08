---
description: Add an AsofScan plan node and a rule that recognizes the lateral-top-1-on-monotonic-with-equi-partition idiom and rewrites it into a streaming asof scan
prereq: monotonic-on-characteristic, bestaccessplan-monotonic-ordering
files: packages/quereus/src/planner/nodes/plan-node-type.ts, packages/quereus/src/planner/nodes/asof-scan-node.ts (new), packages/quereus/src/runtime/emit/asof-scan.ts (new), packages/quereus/src/planner/rules/join/rule-lateral-top1-asof.ts (new), packages/quereus/src/planner/framework/registry.ts

---

## Architecture

The "asof join" — for each left row, the latest right row whose key is ≤ the left's key, optionally per partition — is a recurring shape in time-series, financial, and event-stream queries. Standard SQL expresses it as a lateral-top-1 subquery:

```sql
SELECT t.*, q.bid, q.ask
FROM trades t
LEFT JOIN LATERAL (
  SELECT bid, ask
  FROM quotes q
  WHERE q.symbol = t.symbol AND q.ts <= t.ts
  ORDER BY q.ts DESC
  LIMIT 1
) q ON TRUE;
```

Today this executes per-trade as a correlated subquery against `quotes`: per left row, an index seek into the right plus a one-row read. The cost is `O(L · log R)` for L-row left and R-row right. Acceptable for small L; expensive for batch / streaming workloads where both sides are large.

When `q.ts` is `MonotonicOn` and the right vtab advertises `supportsAsofRight` (companion ticket `1-bestaccessplan-monotonic-ordering`), the work is `O(L + R)` via a streaming merge: walk both inputs in `ts` order, advance the right cursor while it remains ≤ the current left timestamp, emit `(left, right_at_or_before_left)`. For partitioned variants (`PARTITION BY symbol`), the merge runs per partition or maintains per-partition right cursors.

This ticket adds the plan node and the recognition rule. No new SQL grammar — users keep writing the lateral-top-1 idiom.

### The plan node

```ts
// packages/quereus/src/planner/nodes/asof-scan-node.ts

export class AsofScanNode extends PlanNode implements RelationalPlanNode {
  override readonly nodeType = PlanNodeType.AsofScan;

  constructor(
    scope: Scope,
    /** Left (driving) input — must be ordered on matchAttr per partitionAttrs */
    public readonly left: RelationalPlanNode,
    /** Right input — must advertise MonotonicOn(matchAttr) and supportsAsofRight */
    public readonly right: RelationalPlanNode,
    /** Attribute the asof condition compares (left.match ≥ right.match) */
    public readonly matchAttr: { left: number; right: number },
    /** Equi-partition keys (optional). Within a partition the asof runs as a stream merge. */
    public readonly partitionAttrs: readonly { left: number; right: number }[],
    /** Strict (<) vs non-strict (≤) on the asof comparison */
    public readonly strict: boolean,
    /** LEFT JOIN semantics: emit unmatched left rows with NULL right columns */
    public readonly outer: boolean,
  ) { … }

  // Output type: left.heading ⊎ right.heading-without-partition-keys.
  // Ordering: inherits left's ordering (left-driven).
  // MonotonicOn: inherits left's if matchAttr.left is left's MonotonicOn attribute.
}
```

`AsofScan` is internal — the parser never produces it. Its emitter walks both children in match-attribute order, maintaining per-partition right-cursor state, emitting one output row per left row.

### Runtime semantics

Single-partition case (`partitionAttrs = []`):

```
right_cursor = right.iterator()
right_current = null   // last consumed right row
for each left_row in left:
  while right_cursor.hasNext() and right_cursor.peek().match <= left_row.match (strict: <):
    right_current = right_cursor.next()
  if right_current is null and outer:
    emit(left_row + NULL_right)
  elif right_current is not null and right_current.match <= left_row.match:
    emit(left_row + right_current)
  // else if not outer and no match yet: skip
```

Partitioned case (`partitionAttrs ≠ []`):

- Both inputs are partitioned by the partition key with each partition internally sorted on match-attr. The vtab side declares this through ordering + `supportsAsofRight`; the left side either inherits this from its own access plan or is established by an upstream `Sort` (the rule audits this — see preconditions below).
- One implementation: an outer merge by partition key + an inner merge by match-attr per partition. Per-partition right cursors are maintained as long as both inputs' partitions advance in lockstep.
- Alternative: hash-bucketed right-cursor state, keyed on partition. Trades stream order for state size; chosen by the cost model when partitions are small but numerous.

The runtime ticket-author chooses the implementation; the plan node carries enough information for either.

### The rule

The recognition pattern, stated structurally:

```
Project[…, q.* ] (
  LeftJoin (
    Left,                                // any relation; will require ordering
    LateralCorrelate (
      Left,
      Limit(1) (
        Sort([q.K DESC]) (
          Filter (q.K op_left_K) AND eq_partition_constraints (
            Right                         // must provide MonotonicOn(K) and supportsAsofRight
          )
        )
      )
    )
  )
)
```

Where:
- `op` is `<=` (non-strict) or `<` (strict).
- `eq_partition_constraints` is zero or more `q.P_i = t.P_i` predicates that bind right partition columns to left columns.
- The lateral subquery's `Sort` is on `q.K DESC`, `LIMIT 1` extracts the most-recent ≤ row; semantically equivalent to "the asof row for left's K."

Rewrite to:

```
AsofScan(
  Left,
  Right,                              // pre-projected to (P*, K, value-cols)
  matchAttr: (Left.K, Right.K),
  partitionAttrs: each (Left.P_i, Right.P_i),
  strict: (op === '<'),
  outer: parent join is LEFT JOIN
)
```

#### Preconditions checked by the rule

1. `Right` (after stripping the lateral filter and sort) is `MonotonicOn(K)` and the access plan advertises `supportsAsofRight`. If only `MonotonicOn` is set without the capability flag, fall back to per-row index seek (acceptable but not the streaming asof — see "fallback" below).
2. The lateral filter's predicate over `K` is the only inequality on `K`; the equality filters are exclusively partition-binding (`q.P_i = t.P_i`).
3. `Left` is ordered on its own `K` per `partitionAttrs`. If not, the rule may insert a `Sort` if the cost model favors it; otherwise it does not fire.
4. The lateral subquery's `LIMIT 1` is exact (not a parameterized limit, not `LIMIT n` with `n > 1`).
5. The columns selected from the lateral are a subset of right's columns (no re-projection that requires a different shape).
6. `LEFT JOIN LATERAL` vs `JOIN LATERAL` distinguishes outer vs inner asof — both are supported; the rule sets `outer` accordingly.

If any precondition fails, the rule doesn't fire, and the plan executes as the existing correlated-lateral structure.

### Fallback when right is `MonotonicOn` but lacks `supportsAsofRight`

A vtab may be `MonotonicOn` without supporting forward-only asof iteration (e.g., if its scan iterator must restart per-call). In that case the rule may still fire but emit a per-row binary-search shape — `O(L · log R)` instead of `O(L + R)` — using the right's monotonic-ordered access plan to seek per-left-row. This is a separate physical operator (`AsofPerRow`?) or a flag on `AsofScan`; the cost model picks. For the first pass, defer this fallback and require both flags; the rule simply doesn't fire without `supportsAsofRight`.

### Cost

`AsofScan` cost is `O(L + R)` — both inputs streamed once. The existing lateral-top-1 cost is `O(L · log R)`. For any non-trivial `L`, the asof scan wins decisively. The cost model should reflect this so the rule fires reliably.

### Edge cases

- **Strict vs non-strict.** `q.ts < t.ts` (strict) excludes ties; `q.ts <= t.ts` includes them. The match-and-advance logic differs; the plan node carries `strict`.
- **`DESC` lateral.** Required by the standard asof shape. A lateral with `Sort([q.K ASC]) LIMIT 1` and predicate `q.K >= t.K` is the symmetric "next quote at or after" — also recognizable, also asof-scannable in reverse, but possibly out of scope for the first pass; document and defer if so.
- **NULL handling.** SQL three-valued logic on `q.ts <= t.ts` excludes rows with NULL `ts`. The rule respects this (the right scan filters NULLs implicitly because the sorted index excludes them, or the optimizer adds an `IS NOT NULL` predicate).
- **Multiple lateral references in one query** — each lateral-top-1 is independently recognized.

### Adapter implications

Adapters that want to participate:
- The right vtab advertises `MonotonicOn(K)` and `supportsAsofRight`.
- The left side either provides ordered-on-`K` access naturally (Lamina sequence columns; sorted indexes; physical-clustered tables) or accepts an upstream `Sort`.

This makes the asof fast path adapter-agnostic — anything that satisfies the contract gets it.

## TODO

### Phase 1: Plan node
- Add `AsofScan` to `PlanNodeType`.
- Implement `AsofScanNode` (output type derivation, ordering propagation, `MonotonicOn` propagation).
- Emitter: stream-merge runtime (single-partition first; partitioned in a follow-up phase if needed).

### Phase 2: Rule
- Implement `rule-lateral-top1-asof` in `planner/rules/join/`.
- Pattern match: lateral-top-1 with inequality over right's monotonic attribute, equi-partition predicates, optional left-side ordering.
- Register in `planner/framework/registry.ts`.

### Phase 3: Partitioned support
- Extend the emitter to maintain per-partition right cursors. Strategy choice (merge-by-partition-key vs hash-bucketed) is a cost-model decision; ship one and add the other as needed.

### Phase 4: Tests
- Plan-shape tests confirming the rule recognizes the canonical lateral-top-1 idiom and rewrites to `AsofScan`.
- Plan-shape tests for the negative cases: lateral without monotonic right, lateral with multiple inequalities, lateral with `LIMIT n > 1`, etc.
- SQL logic tests over a memory-table fixture confirming equivalence with the un-rewritten plan across boundary cases (empty right, all-unmatched, partition-by, strict vs non-strict).
- Performance microbench (informational, not gated): asof scan wins by orders of magnitude on million-row inputs.
