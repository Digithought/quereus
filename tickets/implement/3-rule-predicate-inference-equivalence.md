---
description: Implement the EC-driven predicate-inference rule that materializes inferred equality predicates from constant bindings and equivalence classes, including branch injection below inner joins.
prereq: fd-property-foundation, fd-from-equivalence-classes
files:
  - packages/quereus/src/planner/rules/predicate/rule-predicate-inference-equivalence.ts (new)
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/src/planner/util/fd-utils.ts (no changes expected — read only)
  - packages/quereus/src/planner/nodes/filter.ts (no changes expected — read only)
  - packages/quereus/src/planner/nodes/join-node.ts (no changes expected — read only)
  - packages/quereus/src/planner/analysis/constraint-extractor.ts (no changes expected — read only)
  - packages/quereus/test/optimizer/rule-predicate-inference-equivalence.spec.ts (new)
  - packages/quereus/test/logic/02-filters.sqllogic
  - docs/optimizer.md
---

## Goal

Add `rulePredicateInferenceEquivalence` — a Structural-pass rule that materializes inferred equality predicates derived from the combination of (predicate-derived) constant bindings and (source-derived) equivalence classes. When `t.k = u.k` is known and `t.k = V` is asserted, the rule emits `u.k = V` so it can flow to vtab access plans on the `u` side independently.

## Background — already-built infrastructure the rule consumes

The FD/EC ticket chain has done the heavy analytic lifting; this rule is the *materialization* surface:

- `FilterNode.computePhysical` (`packages/quereus/src/planner/nodes/filter.ts:79-100`) already calls `extractEqualityFds` on the predicate, merges the predicate's `constantBindings` with the source's, then calls `closeConstantBindingsOverEcs` so a binding pinned on `t.k` automatically widens to cover every EC-equivalent column.
- `JoinNode.computePhysical` (`packages/quereus/src/planner/nodes/join-node.ts:95-133`) → `propagateJoinFds` (`packages/quereus/src/planner/nodes/join-utils.ts:162-233`) emits `equivClasses` for equi-join pairs (with right-side indices shifted by `leftColumnCount`).
- `extractEqualityFds` (`packages/quereus/src/planner/util/fd-utils.ts:383`) returns `{ fds, equivPairs, constantBindings }` keyed by column **index** (position in `source.getAttributes()`), not attribute ID.

So at a `FilterNode(predicate, source)`:
- `extractEqualityFds(predicate, attrIdToIndex)` gives us predicate-level constants `{ colIdx → V }`.
- `source.physical?.equivClasses` gives us EC groups of column indices.
- Crossing the two yields inferred equalities `{ otherColInSameEc → V }` that are *not* already explicit conjuncts in the predicate.

The rule's job: take those inferred (colIdx, V) pairs, find the corresponding `Attribute` on `source.getAttributes()`, synthesize `ColumnReferenceNode = LiteralNode|ParameterReferenceNode` predicates, and either AND them into the filter (simple form) or inject them as `FilterNode` wrappers on the appropriate `JoinNode` branch (powerful form).

## Algorithm

### Triggering

Register the rule on `PlanNodeType.Filter` in the Structural pass. Priority **22** (after `predicate-pushdown` at 20 and `filter-merge` at 21 — placing it after pushdown means inferred predicates synthesized this iteration become visible to a *subsequent* pushdown invocation as the Structural pass iterates to fixed-point; placing it after filter-merge prevents this rule from churning on filter chains the merge would consolidate first).

### Simple form (always run)

For each `FilterNode(predicate, source)`:

1. Build `attrIdToIndex` over `source.getAttributes()`.
2. `predBindings = extractEqualityFds(filter.predicate, attrIdToIndex).constantBindings`. These tell us *which columns the predicate itself directly pins* (a `col = literal` or `col = ?` conjunct).
3. `sourceEcs = source.physical?.equivClasses ?? []`.
4. For each `binding = { attrs: [predColIdx], value }` in `predBindings`:
   - Find every EC `cls` that contains `predColIdx`. For each `otherIdx ∈ cls, otherIdx !== predColIdx`:
     - If the existing predicate does **not** already contain `attr(otherIdx) = value` (and does not contain `value = attr(otherIdx)`), schedule emission of a new conjunct on `otherIdx`.
5. If any new conjuncts were scheduled, synthesize them (see below) and AND them onto the existing predicate. Return the rebuilt `FilterNode`.
6. If nothing was scheduled, return `null` (rule doesn't fire).

The "already contains" check is the **fixpoint guard** — on the rule's next visit to the same node, every inferred equality is already in the predicate, so step 4 schedules nothing and step 6 returns null. The registry's per-node `markRuleApplied` is a belt-and-suspenders second guard.

### Powerful form (when source is an inner JoinNode)

If the rebuilt FilterNode's source is a `JoinNode` of type `inner` or `cross`, additionally:

1. Split the *newly inferred* conjuncts (NOT the original predicate) by which side of the join their columns reference. Left attributes are indexes `0..leftColumnCount-1`, right are `leftColumnCount..`.
2. For each new conjunct that references only **one side**'s attributes, inject a `FilterNode` wrapping that side's branch with the conjunct re-keyed onto the branch's attributes (column index `i` on the right becomes index `i - leftColumnCount` on the right branch). Attribute IDs are stable across the rewrite, so reusing the same ColumnReferenceNode shape works.
3. Build a new JoinNode with the wrapped branches; build a new outer FilterNode that still contains the augmented predicate (including the inferred conjuncts). The branch filter handles the access-plan pushdown work; the outer filter is harmless and may be elided by future filter merging — keeping it is simpler and provably correct.

For LEFT join: only conjuncts whose columns reference the **left** (preserved) branch may be injected on the left branch. Right-branch injection on a LEFT JOIN is **unsafe** — it would prune null-padded rows that satisfy the equi-join trivially. Per the plan ticket, `propagateJoinFds` already drops right-side bindings for LEFT joins, so we generally won't see right-side inferences arise from a LEFT join's bindings, but the rule must still defensively refuse right-branch injection on LEFT (and symmetric refusal on RIGHT, and refuse both on FULL).

For SEMI/ANTI: only the left side is in the output; treat as LEFT for the purpose of branch injection. No inferred predicate references right columns from the output, so this falls out naturally.

### Synthesizing the inferred predicate

For an inferred binding `(targetIdx, value)`:

- Look up `attr = source.getAttributes()[targetIdx]`.
- Build `ColumnReferenceNode(scope, { type: 'column', name: attr.name }, attr.type, attr.id, targetIdx)`. (See `packages/quereus/src/planner/rules/cache/rule-scalar-cse.ts:225-235` for the established pattern of synthesizing a column ref from an `Attribute`.)
- Build the value node:
  - `value.kind === 'literal'`: `LiteralNode(scope, { type: 'literal', value: value.value })` (see `rule-select-access-path.ts:872`).
  - `value.kind === 'parameter'`: `ParameterReferenceNode(scope, { type: 'parameter', name: typeof value.paramRef === 'string' ? value.paramRef : '?' }, value.paramRef, attr.type)`.
- Wrap as `BinaryOpNode(scope, { type: 'binary', operator: '=', left, right }, colRef, valueNode)`.

For branch injection, the **same attr.id and attr.type** apply on the branch (attribute IDs are stable), but the `columnIndex` must be the branch-relative index, not the join-output index. Look up the branch's index by scanning `branch.getAttributes()` for the matching `id`.

### "Already contains" check

A predicate may textually contain `col = value` even if `extractEqualityFds` didn't surface it (e.g., it was wrapped in a different shape). Be conservative — over-adding a redundant conjunct is safe but wasteful. Compare structurally: walk the predicate's AND tree, look for `BinaryOpNode(operator='=', col, val)` where `col` is a `ColumnReferenceNode` with matching `attributeId` and `val` is a literal/parameter with a matching `ConstantValue` (use a comparison analogous to `constantValueEquals` in `fd-utils.ts:475` — exported it later if needed; otherwise re-implement locally).

A simpler signal: rebuild the set of `extractEqualityFds(predicate).constantBindings` for the new predicate and only emit conjuncts that would *add* a new binding. If the rule emits no new bindings, return `null`. This is the recommended approach because it reuses existing infrastructure and naturally provides the fixpoint guard.

## Interaction with the rest of the pipeline

- After this rule emits inferred predicates on a `FilterNode`, the next iteration of the Structural pass runs `predicate-pushdown` (priority 20 < 22, so it fires on the next traversal). Predicate-pushdown carries supported conjuncts into `RetrieveNode` boundaries via `extractConstraints`, which already understands single-column equality on literals and parameters. **No changes to `constraint-extractor.ts` are required.**
- The branch injection produces a `FilterNode` *between* the JoinNode and the branch's source. On subsequent passes, `predicate-pushdown` carries that branch filter into the leaf's Retrieve pipeline normally.
- `ruleJoinElimination` (priority 24) runs after this rule. The inferred predicates may protect a side that would otherwise have been eliminated — that's correct: a filter that references a column means the side is "referenced," so elimination correctly defers. No special interaction needed.

## Testing

### Unit-style spec (`test/optimizer/rule-predicate-inference-equivalence.spec.ts`)

Mirror the style of `test/optimizer/rule-orderby-fd-pruning.spec.ts` / `test/optimizer/fd-equivalence.spec.ts` — drive through the engine via real SQL with `query_plan(?)` introspection, plus a few direct rule invocations on hand-built plans for tight unit tests on edge cases:

- **Single-hop equi-join with constant filter** (`WHERE t.k = u.k AND t.k = 5`): plan contains a Filter on the u-side branch with `u.k = 5`, and the join's right branch has its inferred predicate. Verify by walking `query_plan(?)` output for a `Filter` node directly above the `Retrieve` covering `u`, whose `detail` mentions `u.k = 5`.
- **Multi-hop chain** (`a JOIN b ON a.x=b.x JOIN c ON b.x=c.x WHERE a.x=7`): all three branches (a, b, c) end up with their own `Filter(*.x = 7)`. The structural pass iterates to fixed-point, so the second join boundary picks up the inference on its second iteration.
- **LEFT JOIN safety** (`t LEFT JOIN u ON t.k=u.k WHERE t.k=5`): the outer Filter retains `t.k = 5`; the **right** (u) branch must NOT carry an injected `u.k = 5` filter. Assert no Filter wraps the u-side Retrieve.
- **Parameter binding** (`WHERE t.k = u.k AND t.k = ?`): inferred predicate on `u.k = ?` references the same parameter slot. Verify the synthesized `ParameterReferenceNode.nameOrIndex` matches the original.
- **Idempotence**: invoke the rule twice on the same FilterNode. Second call returns `null` (no new conjuncts).
- **No-op when no EC crosses**: `WHERE t.k = 5` without an equi-join produces no inference (binding affects only one column).
- **No-op when no constant**: `t JOIN u ON t.k = u.k` with no constant binding produces no inference.
- **Mixed inference still pushes correctly**: `WHERE t.k = u.k AND t.x > 0 AND t.k = 5` — the inferred `u.k = 5` lands on the u-branch; `t.x > 0` doesn't drag along.

### Plan-shape tests

Add at least one assertion to `test/optimizer/plan-shape-decisions.spec.ts` (or a sibling file if more natural) that confirms the inferred branch filter results in the vtab module's `xBestIndex` seeing the equality constraint on the u-side. Easiest: scan `query_plan(?)` for the Retrieve node's `physical` / `detail` and confirm the constraint count or pushed-predicate string includes `u.k = 5`.

### Logic regression (`test/logic/02-filters.sqllogic`)

Append a small block exercising:
```sql
create table t (k int primary key, v int);
create table u (k int primary key, v int);
insert into t values (1, 'a'), (5, 'e'), (10, 'j');
insert into u values (5, 'E'), (7, 'G'), (10, 'J');
select t.v, u.v from t join u on t.k = u.k where t.k = 5;
select t.v, u.v from t join u on t.k = u.k where t.k = ?;
-- (with ? = 10)
```
Results must be identical before/after the rule lands (semantic equivalence is the bar — the test exists to catch any case where inference accidentally over-prunes).

## Documentation updates

- **`docs/optimizer.md`** § "Predicate" rule catalog (line ~475): add a bullet for `rulePredicateInferenceEquivalence` describing the rule and citing the priority. Cross-reference the existing "Functional Dependency Tracking" section. Insert a short worked example showing the inference chain on the EC framework section.
- **No `docs/architecture.md` change required** (no new pipeline boundary).

## Implementation TODO

- Implement `packages/quereus/src/planner/rules/predicate/rule-predicate-inference-equivalence.ts` exporting `rulePredicateInferenceEquivalence(node, context): PlanNode | null`. Internal helpers: `synthesizeEqualityPredicate(scope, attr, branchColIdx, value)`, `tryBranchInjection(filter, join, inferredConjuncts)`, and a small "predicate already contains this binding" check based on `extractEqualityFds`.
- Register the rule in `Optimizer.registerRulesToPasses` (`packages/quereus/src/planner/optimizer.ts`) under the Structural pass: `id: 'predicate-inference-equivalence'`, `nodeType: PlanNodeType.Filter`, `phase: 'rewrite'`, `priority: 22`. Add the import alongside the other predicate rules.
- Bump the existing `scalar-cse` priority comment if needed (currently 22 — pick **23** for inference-equivalence and bump scalar-cse to 22 stays; reorder if a conflict). On re-read: `scalar-cse` is on `PlanNodeType.Project`, not Filter, so they don't collide. Keep `scalar-cse` at 22 and put this rule at 22 on Filter — no collision since priorities are per-node-type.
- Add the unit/plan-shape spec at `packages/quereus/test/optimizer/rule-predicate-inference-equivalence.spec.ts`.
- Add the logic block to `packages/quereus/test/logic/02-filters.sqllogic`.
- Update `docs/optimizer.md` per "Documentation updates" above.
- Run `yarn workspace @quereus/quereus run lint` and `yarn test` from repo root. Stream test output (`2>&1 | tee /tmp/test.log`) per AGENTS.md.

## Known gaps for the reviewer

- Range and IS NULL inference are intentionally **out of scope** per the plan ticket. Confirm we did not accidentally enable either.
- The rule only injects below `inner`/`cross` joins. For LEFT/RIGHT joins it falls back to the simple form (outer Filter only). If the reviewer suspects the safety analysis is too conservative (e.g., wants left-side injection on LEFT JOIN), call it out — that's the next-easy extension but isn't in this ticket's scope.
- The "already contains" check uses `extractEqualityFds` round-tripping, not full AST equality. A predicate that *implies* `col = V` through a non-equality shape (e.g., `col IN (V)`) will still receive an inferred `col = V`. That's redundant but correct; flag if it shows up as a measurable cost.
- No selectivity rewrite — inferred predicates don't update `estimatedRows`. The downstream FilterNode's heuristic 0.5 selectivity applies. Tightening the estimate is a follow-up.
