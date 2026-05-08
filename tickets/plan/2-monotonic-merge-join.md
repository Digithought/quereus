---
description: Add a MonotonicMerge plan node and a rule that recognizes equi-joins on aligned monotonic columns and rewrites them into a streaming merge join
prereq: monotonic-on-characteristic, bestaccessplan-monotonic-ordering
files: packages/quereus/src/planner/nodes/plan-node-type.ts, packages/quereus/src/planner/nodes/monotonic-merge-node.ts (new), packages/quereus/src/runtime/emit/monotonic-merge.ts (new), packages/quereus/src/planner/rules/join/rule-monotonic-merge-join.ts (new), packages/quereus/src/planner/framework/registry.ts

---

## Architecture

When two relations are both `MonotonicOn(X)` and joined by `l.X = r.X`, the join can be served as a single streaming merge in `O(N + M)`: walk both inputs in `X` order, emit pairs whose `X` matches, advance the side with the smaller current `X`. No buffering, no hash table, no sort.

Quereus already implements merge-join (`merge-join-node.ts`) for cases where ordering is inferable from existing properties. This ticket adds an explicit recognition rule that fires whenever both inputs satisfy the strong `MonotonicOn` property — a strictly broader set of plans than the existing rule covers, because `MonotonicOn` is the durable property under filter, project, and other order-preserving transformations (per `1-monotonic-on-characteristic`'s propagation), whereas the existing merge-join recognition relies on local ordering observation.

The new plan node is internal; the existing `MergeJoinNode` may already serve as the runtime shape if its emitter is general enough. If so, this ticket reduces to a recognition rule that targets the existing node; if not, we add a `MonotonicMerge` variant. The implementer's choice based on inspection of the existing node.

### What's broader than the existing recognition

The existing `merge-join-rule` (or equivalent) recognizes orderings that the input nodes already declare in `physical.ordering`. The MonotonicOn-aware rule additionally recognizes:

- Inputs whose ordering was *propagated* through filters, projections, renames, set unions with disjoint ranges, etc., where each step preserves `MonotonicOn(X)` per the propagation table in `1-monotonic-on-characteristic`.
- Inputs whose `MonotonicOn` derives from a vtab access plan (storage-sorted), which the existing rule may or may not see depending on how access-plan ordering is lifted today.
- Cases where the join condition is a chain of equalities `l.X = r.X AND l.Y = r.Y`, where both sides are jointly `MonotonicOn` on the prefix `(X, Y)` — composite monotonic; out of scope for v1 of this ticket but a natural extension.

The first two are the meaningful wins; the third is parked.

### The plan node

```ts
// packages/quereus/src/planner/nodes/monotonic-merge-node.ts

export class MonotonicMergeNode extends PlanNode implements RelationalPlanNode {
  override readonly nodeType = PlanNodeType.MonotonicMerge;

  constructor(
    scope: Scope,
    public readonly left: RelationalPlanNode,
    public readonly right: RelationalPlanNode,
    /** Equi-join keys, in matched-pair form */
    public readonly equiKeys: readonly { left: number; right: number }[],
    /** Inner / left-outer / right-outer / full-outer */
    public readonly joinKind: 'inner' | 'left' | 'right' | 'full',
  ) { … }

  // Output type: standard join output type.
  // Ordering: MonotonicOn the join key (both sides agree); preserved on output.
  // MonotonicOn: the join key, if both inputs were strict on it.
}
```

If the existing `MergeJoinNode` is general enough to express this, this ticket reuses it and only adds the rule; the `MonotonicMergeNode` class above is illustrative.

### The rule

```
Join(condition: l.X = r.X AND additional_conjuncts) (Left, Right)
  where Left is MonotonicOn(l.X)
    and Right is MonotonicOn(r.X)
    and direction agrees (both asc or both desc)
  → MonotonicMerge(Left, Right, equiKeys=[(l.X, r.X)], joinKind=…)
    .above(Filter(additional_conjuncts))
```

Additional conjuncts (non-equality predicates, predicates on other columns) sit as a filter above the merge, the same way they would for any join.

#### Preconditions

1. Both inputs `MonotonicOn(X)` with matching direction.
2. Equi-join condition on the monotonic attributes; either side may have additional equi-conditions (treated as filters above the merge for the first pass; multi-key merge a future extension).
3. Outer-join semantics handled per the standard merge-outer protocol — the unmatched side emits with NULLs on the other side at the appropriate moments in the merge.

#### Strict vs non-strict

If either side is non-strict on `X` (duplicates allowed), the merge still works but must handle `n × m` duplicate runs at each `X` value. Standard merge-join discipline; the existing implementation likely covers it.

### Cost

Merge-join cost on monotonic-streamed inputs is `O(N + M)` plus the duplicate-run cost. Hash join is `O(N + M)` plus a build-table cost (memory-bound). The cost model should pick merge when:

- Both inputs are large enough that hash-table build is expensive.
- The monotonic property is robust (i.e., not a one-off sort that itself costs `O(N log N)`).
- The output of the merge is consumed by something that benefits from preserved order (a downstream `OrdinalSlice`, `LIMIT`, or window function).

The cost model already prices these factors; this ticket ensures the merge alternative is *visible* to costing whenever the precondition is satisfied.

### Composition

A monotonic merge composes naturally with other monotonic-on rules:
- Its output is `MonotonicOn(X)`, so a downstream `OrdinalSlice` can fire.
- A `Filter` over the merge result preserves `MonotonicOn(X)`, so further composition continues.
- Its inputs are typically retrieve nodes with range scans (`2-monotonic-range-scan`); the merge sees the bounded sub-streams and runs over them.

## TODO

### Phase 1: Audit existing merge-join
- Inspect `merge-join-node.ts` and its rule. Decide whether to reuse the existing node and only add a recognition rule, or add a new `MonotonicMergeNode`. Prefer reuse if the existing node's runtime is general.

### Phase 2: Rule
- Implement `rule-monotonic-merge-join` in `planner/rules/join/`.
- Recognition pattern as specified; cost-model wiring so the rule wins on large inputs and loses appropriately on small inputs (where hash-join's lower constant factors win).
- Register in `planner/framework/registry.ts`.

### Phase 3: Outer-join semantics
- Confirm the merge-join runtime handles inner/left/right/full correctly under monotonic-on inputs. Add tests if not already covered.

### Phase 4: Tests
- Plan-shape tests confirming the rule fires on the recognized pattern, with both sides advertising `MonotonicOn` directly via access plans and through propagation (filter, project preserving the key).
- SQL logic tests over a memory-table fixture verifying correctness across inner/outer kinds, strict/non-strict inputs, and multi-conjunct join conditions.
- Negative tests confirming the rule doesn't fire for unequal directions, non-monotonic inputs, or non-equi-join conditions on the monotonic attribute.
