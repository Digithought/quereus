---
description: Add an OrdinalSlice plan node and an optimizer rule that rewrites ORDER BY <monotonic> LIMIT n OFFSET k into an O(log N) ordinal seek when the access path supports it
prereq: monotonic-on-characteristic, bestaccessplan-monotonic-ordering
files: packages/quereus/src/planner/nodes/plan-node-type.ts, packages/quereus/src/planner/nodes/ordinal-slice-node.ts (new), packages/quereus/src/runtime/emit/ordinal-slice.ts (new), packages/quereus/src/planner/rules/access/rule-monotonic-limit-pushdown.ts (new), packages/quereus/src/planner/framework/registry.ts

---

## Architecture

`SELECT … FROM t ORDER BY x LIMIT n OFFSET k` over a table sorted on `x` is the canonical paginate-into-the-middle query. The current execution shape applies `LimitOffsetNode` above the scan: the scan emits `k + n` rows, the runtime drops the first `k` and emits the next `n`. For deep offsets this is wasteful — the scan does work proportional to `k`, all of it discarded.

When the underlying access path is `MonotonicOn(x)` and advertises `supportsOrdinalSeek` (companion ticket), the offset is satisfiable by the storage in `O(log N)`: the engine seeks directly to the (k)th leaf in monotonic order, then emits `n` rows. This ticket adds the plan node and rule that recognize the pattern and route it through the access plan.

### The plan node

```ts
// packages/quereus/src/planner/nodes/ordinal-slice-node.ts

export class OrdinalSliceNode extends PlanNode implements RelationalPlanNode {
  override readonly nodeType = PlanNodeType.OrdinalSlice;

  constructor(
    scope: Scope,
    /** The retrieve-shaped child whose access plan supports ordinal seek */
    public readonly source: RelationalPlanNode,
    /** Attribute we're sliced on (must match source's MonotonicOn) */
    public readonly attrId: number,
    /** 0-based ordinal of the first emitted row; may be a parameter */
    public readonly offsetExpr: ScalarPlanNode,
    /** Number of rows to emit; may be a parameter; null/undefined = unbounded */
    public readonly limitExpr: ScalarPlanNode | undefined,
    /** Direction inherited from the source's MonotonicOn */
    public readonly direction: 'asc' | 'desc',
  ) { … }

  // Output type is identical to source's; ordering inherits MonotonicOn(attrId, direction).
}
```

`OrdinalSlice` is internal — it is never produced by the parser, only by the rule below. Its emitter delegates to the vtab via the existing access-plan path, with the `BestAccessPlanRequest.offset` field set to the resolved offset value and the request's limit set to the (resolved) limit. The vtab's `query()` walks its index from the seeked position and emits the requested run.

### The rule

```
LimitOffset(limit=n, offset=k) over Sort(by=[x ASC]) over R
  where R provides MonotonicOn(x, asc) and supportsOrdinalSeek
  → OrdinalSlice(R, x, k, n, asc)
```

Generalizations the rule should handle:

- **The `Sort` may be absent** when `R` already produces rows in the right order — common when `R` is itself `MonotonicOn(x)`. The rule fires whenever the input to `LimitOffset` is `MonotonicOn(x)` matching the requested `ORDER BY`.
- **`OFFSET` without `LIMIT`** — the slice covers `[k, ∞)`. The vtab seeks once and walks; still wins for large `k`.
- **`LIMIT` without `OFFSET`** — equivalent to `OFFSET 0 LIMIT n`. Whether to fire depends on cost; for small `n` the slice and the existing limit pushdown are equivalent.
- **Parameterized `LIMIT/OFFSET`** — `n` and `k` may be `ScalarPlanNode`s carrying parameter references. The rule passes them through to the slice node; the runtime resolves them at execute time and includes them in the access-plan request.
- **`ORDER BY x DESC`** — fires if `R` advertises `MonotonicOn(x, desc)` or the access plan supports reverse iteration. The slice's `direction` is set accordingly.

The rule must **not** fire when:

- The input is sorted on `x` but not `MonotonicOn` (e.g., in-memory sort over a non-monotonic source — the sort buffer doesn't help with offset; the existing limit pushdown already covers it correctly).
- The `ORDER BY` includes attributes other than the advertised monotonic attribute (multi-key ordering — out of scope).
- A `WHERE` clause that wasn't fully handled by the access plan sits between the slice and the source. The slice operates on the access plan's emit order; an unhandled filter would alter the cardinality and invalidate the offset arithmetic. The rule fires only when intermediate filters are residual-free.

### Cost

The rule's cost calculation should reflect the dramatic asymptotic improvement: `OrdinalSlice` costs `O(log N + n)` against the existing `LimitOffset(over Sort(over Scan))` shape's `O(N log N + n)` (with sort) or `O(k + n)` (without sort). The cost model should favor the slice strongly for any non-trivial `k`.

### Runtime

The emitter's job is small: resolve `offsetExpr` and `limitExpr` to integers, build a `BestAccessPlanRequest` with the resolved values, invoke the vtab's `query()` (or its access-plan-driven entry point), and forward the resulting `AsyncIterable<Row>`. No buffering, no count-and-discard.

The vtab is responsible for honoring the request — i.e., when `supportsOrdinalSeek` is advertised, the vtab's `query()` must accept `offset` in the access-plan choice and seek accordingly. This is the contract that `1-bestaccessplan-monotonic-ordering` documents.

### Interaction with existing limit-pushdown

Quereus already has a `BestAccessPlanRequest.limit/offset`-based pushdown for cases where the access plan accepts the request. That mechanism is for "scan emits limit+offset rows; runtime applies offset above." `OrdinalSlice` is the case where the scan satisfies *both*. Decision tree:

1. If retrieve advertises `supportsOrdinalSeek` and `MonotonicOn` matches the requested `ORDER BY` → emit `OrdinalSlice` (this rule).
2. Else if retrieve accepts `limit/offset` in `BestAccessPlanRequest` (existing) → emit the existing `LimitOffset` over the limit-pushed scan.
3. Else fall back to `LimitOffset` over `Sort` over scan (existing).

Branches 2 and 3 are unaffected by this ticket.

### Adapter implications

Vtab modules that want to participate in this fast path:

- Advertise `monotonicOn` and `supportsOrdinalSeek` in `BestAccessPlanResult` when their access path supports both.
- Honor `BestAccessPlanRequest.offset` in their `query()` implementation when those flags are advertised.

Modules that don't participate continue to work; the rule simply doesn't fire on their plans.

## TODO

### Phase 1: Plan node
- Add `OrdinalSlice` to `PlanNodeType`.
- Implement `OrdinalSliceNode` in `planner/nodes/`. Output type, ordering, and `MonotonicOn` propagation match the source.
- Matching emitter in `runtime/emit/`; resolve `offsetExpr`/`limitExpr` and forward to the vtab.

### Phase 2: Rule
- Implement `rule-monotonic-limit-pushdown` in `planner/rules/access/`.
- Register in `planner/framework/registry.ts`.
- Cost: ensure the rule wins decisively over the existing limit-pushdown for any `k > N_THRESHOLD` (small constant).

### Phase 3: Tests
- Plan-shape tests over a memory-table fixture that advertises `monotonicOn + supportsOrdinalSeek` (see `1-bestaccessplan-monotonic-ordering`'s reference implementation).
- SQL logic tests confirming correct results for `ORDER BY x LIMIT n OFFSET k` across a range of `(n, k)` shapes, including parameterized.
- Negative tests confirming the rule doesn't fire when the access path doesn't advertise the capability, when an unhandled filter sits between the slice and the source, when the ORDER BY isn't on the monotonic attribute, etc.
