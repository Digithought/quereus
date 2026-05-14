---
description: Finish the EC layer — extend the equality-FD extractor to cover parameter bindings (constants within an execution) and add focused end-to-end EC tests. The bulk of EC derivation already landed with `fd-property-foundation`; this ticket closes the remaining gaps so the predicate-inference and ordering-inference rules have what they need.
prereq: fd-property-foundation
files:
  - packages/quereus/src/planner/util/fd-utils.ts
  - packages/quereus/src/planner/nodes/filter.ts
  - packages/quereus/src/planner/nodes/join-utils.ts
  - packages/quereus/test/optimizer/fd-equivalence.spec.ts (new)
  - docs/optimizer.md
---

## Context: what already landed in `fd-property-foundation`

The foundation ticket overshot its stated scope and absorbed most of this ticket's machinery:

- `PhysicalProperties.equivClasses?: ReadonlyArray<ReadonlyArray<number>>` is in place on every relational node.
- `fd-utils.ts` ships `mergeEquivClasses`, `addEquivalence`, `shiftEquivClasses`, plus an `extractEqualityFds(predicate, attrIdToIndex)` walker that emits FDs and EC pairs from `col = literal` and `col1 = col2` conjuncts.
- `FilterNode.computePhysical` (`packages/quereus/src/planner/nodes/filter.ts:79-103`) inherits child ECs and merges in equality conjuncts.
- `propagateJoinFds` (`packages/quereus/src/planner/nodes/join-utils.ts:155-211`) implements the inner/cross EC merge with shifting, the LEFT-preserves-left rule, the RIGHT-preserves-right rule, full-outer drops both, and semi/anti keep left. This matches the rules described in the plan.
- Project / Returning / Alias / Distinct / Aggregate / StreamAggregate / HashAggregate / SetOperation / Window all propagate ECs in line with the plan's per-operator table.
- `fd-propagation.spec.ts` already covers: TableReference (PK + UNIQUE), Filter (`col = literal`, `col1 = col2`, non-equality ignored), Project/Alias/Distinct/aggregates, inner join (bi-FDs + EC merge), LEFT outer (right + equi dropped), UNION ALL, Window.

What is **not** yet done:

1. **Parameter bindings as constants.** `fd-utils.ts:410-416` deliberately rejects `ParameterReferenceNode` in `isPredicateConstant`, so `WHERE col = ?` produces neither a `∅ → col` FD nor any binding metadata. The plan calls for parameter handling (the predicate-inference rule needs it; prepared statements are the headline win).
2. **Constant-binding surface for downstream rules.** The plan describes a `ConstantBinding { attrs, value }` companion structure so `rule-predicate-inference-equivalence` and ordering-inference can read off "which EC is pinned to which value" without re-walking predicates. Today only the implicit `∅ → col` FDs carry this, and they don't capture *which* constant.
3. **End-to-end EC tests** at the join-output level and across the parameter boundary. Existing tests cover the propagation table; we still want a small focused spec asserting the cross-table behaviours the predicate-inference and ordering-inference rules will rely on.
4. **Docs** — `docs/optimizer.md` does not yet have the "Equivalence Classes" subsection or the parameter-binding note.

## Architecture for this pass

### 1. Parameter bindings as constants

A parameter's value is fixed for one execution, so within a single plan execution `col = ?` pins `col` to a single value across all rows — exactly the semantic of `∅ → col`. Treat `ParameterReferenceNode` as predicate-constant in the FD/EC extractor.

Concrete change in `fd-utils.ts`:

```typescript
function isPredicateConstant(n: ScalarPlanNode): boolean {
  if (n instanceof LiteralNode) return true;
  if (n instanceof ParameterReferenceNode) return true;
  return false;
}
```

The companion comment is rewritten to reflect that `computePhysical` describes properties true *for every row of a single execution*, which is exactly the scope parameters satisfy. Subqueries / correlated expressions remain rejected (they can vary per-row in correlated contexts and we do not currently distinguish them at this site).

The downstream effect is automatic: `extractEqualityFds` already emits `∅ → col` for `col = const`, so Filter will now record a constant FD on parameter-equality predicates and feed it into the join's EC layer via the join's `propagateJoinFds`. (No change is required in `propagateJoinFds` — it merges FDs/ECs from both sides.)

### 2. ConstantBinding surface

Add a small typed structure to the FD/EC helper module and surface it on `PhysicalProperties`:

```typescript
// fd-utils.ts
export type ConstantValue =
  | { kind: 'literal'; value: SqlValue }
  | { kind: 'parameter'; paramIndex: number };

export interface ConstantBinding {
  /** Output column indices that are pinned to `value`. */
  readonly attrs: readonly number[];
  readonly value: ConstantValue;
}
```

```typescript
// plan-node.ts (PhysicalProperties)
/**
 * Output columns pinned to a known constant value within a single execution.
 * Mirrors `∅ → col` FDs but carries the *value* so downstream rules (predicate
 * inference, ordering pruning) can rewrite predicates without re-walking the
 * source predicate AST.
 */
constantBindings?: readonly ConstantBinding[];
```

Derivation in `extractEqualityFds` (rename or augment — see below): when a conjunct of the form `col = literal` or `col = ?` is seen, in addition to the `∅ → col` FD, emit a `ConstantBinding` with the literal's value or the parameter's index.

Propagation rules (mirror the FD/EC rules):

- **Filter**: inherit child bindings; merge in predicate-derived bindings, then **transitive close** with the new EC list — if `col` is bound to `v` and `col` is in an EC with `col2`, emit a binding `col2 → v` as well. This is the crux of predicate inference: it lets the rule consume `constantBindings` directly without walking ECs.
- **Inner/cross join**: union of left bindings + right bindings (right's column indices shifted). After the equi-pair merge, run the same transitive-close step so a left-side `t.x = 5` plus an equi-pair `t.x = u.y` lands as `u.y → 5` in the join output's bindings.
- **Left outer**: keep left's bindings; drop right's (NULL-padding can violate them).
- **Right outer**: mirror.
- **Full outer / semi / anti**: same rules as ECs (full drops both; semi/anti keep left).
- **Project / Returning / Alias**: project the column indices through the mapping; drop bindings whose `attrs` lose all members.
- **Distinct / Aggregate**: bindings on GROUP BY columns survive; aggregate-output columns get none.
- **SetOperation / Window**: drop conservatively (matches FD/EC rule for SetOp; Window passes through — keep bindings unchanged).

Implementation locations:

- `fd-utils.ts`: new `ConstantValue`, `ConstantBinding` types; helpers `mergeConstantBindings(a, b)` and `closeConstantBindingsOverEcs(bindings, ecs)`.
- `plan-node.ts`: add the field to `PhysicalProperties`.
- `filter.ts`: thread the extractor output through; close over EC list before returning.
- `join-utils.ts`: extend `propagateJoinFds` (or add a sibling `propagateJoinConstantBindings`) to handle the union + shift + close-over-EC step.
- All other relational nodes already calling project / pass-through helpers gain a parallel call for bindings. Keep the per-operator change minimal: a one-line `propagateConstantBindings(...)` helper that mirrors the existing `propagateFds` ergonomics.

Cap behaviour: like FDs, cap the per-node binding list (re-use `MAX_FDS_PER_NODE` for the same threshold, drop oldest beyond cap — bindings inside a unique-key column are preferred). Log under `quereus:planner:fd` on truncation.

### 3. Extractor return-shape change

`extractEqualityFds` currently returns `{ fds, equivPairs }`. Extend to `{ fds, equivPairs, constantBindings }` so Filter can pull all three out of a single walk. The constant case (`col = literal`) and the parameter case (`col = ?`) both contribute a binding *in addition to* the existing `∅ → col` FD. The column-equality case is unaffected.

```typescript
export interface EqualityFds {
  readonly fds: ReadonlyArray<FunctionalDependency>;
  readonly equivPairs: ReadonlyArray<readonly [number, number]>;
  readonly constantBindings: ReadonlyArray<ConstantBinding>;
}
```

Filter is the only current caller; the return-shape change is local.

### 4. Outer-join refinement is **explicitly out of scope**

The plan mentions a possible refinement for outer joins ("a right-side EC `{r1, r2}` survives if both are part of the equi-pair set"). That is tracked separately by `2-fd-outer-join-key-preservation`. This ticket stays with the conservative rule the foundation shipped.

## Tests (`test/optimizer/fd-equivalence.spec.ts`)

A focused new spec, complementing the existing `fd-propagation.spec.ts`. Use the `query_plan(?)` introspection pattern that `fd-propagation.spec.ts` already uses for parity.

- **Parameter constant FD**: `SELECT * FROM t WHERE id = ?` — assert `fds` contains `∅ → id` and `constantBindings` contains `{ attrs: [id], value: { kind: 'parameter', paramIndex: 0 } }`.
- **Literal + parameter mix**: `WHERE id = 5 AND name = ?` — assert two constant bindings, one literal-valued and one parameter-valued.
- **Cross-EC binding closure**: `WHERE t.a = t.b AND t.a = 7` — assert `constantBindings` contains a binding whose `attrs` include both `a` and `b` (single binding with the EC's two members, not two separate bindings).
- **Join-output binding from one-sided constant**: `SELECT * FROM t JOIN u ON t.k = u.k WHERE t.k = 5` — assert the join's physical properties expose a single binding `{ attrs: [t.k, u.k], value: literal 5 }`. (This is the input the predicate-inference rule will read.)
- **Parameter binding through equi-join**: same shape with `t.k = ?` — assert the binding carries the parameter index and covers both sides.
- **LEFT JOIN drops right-side constant**: `t LEFT JOIN u ON t.k = u.k` with `t.k = 5` on the join's input — assert the right side's `u.k` is **not** in any binding on the join output (foundation drops the equi-pair EC on left outer; binding closure inherits that).
- **EC survives projection of one member**: `SELECT a FROM (SELECT a, b FROM t WHERE a = b)` — assert the outer scope has no EC (b dropped) but the binding is unchanged if there was one.
- **Property test (optional, fast)**: random equality-only predicates over a small column set — derived EC partition matches a reference union-find implementation. Re-use the random-AST helper from `fd-propagation.spec.ts` if one exists; otherwise inline a 30-line generator.

End-to-end logic test: not required for this ticket — the consumer rules (`rule-predicate-inference-equivalence`, ordering inference) own the behavioural sqllogic. This ticket is metadata-only.

## Documentation

- **`docs/optimizer.md`** — under the existing "Functional Dependency Tracking" section, add a short "Equivalence Classes" subsection:
  - What an EC is (column-set with row-wise equality).
  - How ECs flow alongside FDs (the per-operator table already lists them; just point at it).
  - The constant-binding companion: what it is, how it differs from `∅ → col` FDs (carries the value).
  - Note that parameters are treated as constants here.
- **`docs/architecture.md`** — already mentions the FD framework; no change required (the foundation ticket updated it).

## Validation

- `yarn build`
- `yarn workspace @quereus/quereus run lint`
- `yarn test` (quereus package). The existing 41 fd-propagation tests must remain green; the new fd-equivalence tests add ~8.
- `yarn test:store` — skip (metadata only).

## TODO

- Extend `isPredicateConstant` in `fd-utils.ts` to accept `ParameterReferenceNode`; update the surrounding comment to reflect the per-execution semantics.
- Add `ConstantValue` / `ConstantBinding` types in `fd-utils.ts` and helpers `mergeConstantBindings`, `closeConstantBindingsOverEcs`, `projectConstantBindings`, `shiftConstantBindings`.
- Extend `extractEqualityFds` to emit `constantBindings`; update the return type and the Filter caller. Both literal and parameter equality contribute a binding; column-equality is unchanged.
- Add `constantBindings?` to `PhysicalProperties` in `plan-node.ts` with a doc comment.
- Thread `constantBindings` through every node that currently propagates `fds` / `equivClasses`:
  - `FilterNode` — inherit + extract + close over the resulting EC list.
  - Join nodes (inner/cross, left/right outer, full, semi/anti) via `propagateJoinFds` or a sibling helper — union + shift + close over the merged EC list, with the same drop-on-NULL-padded-side rule as ECs.
  - Project / Returning / Alias — project through the column mapping using `projectConstantBindings`.
  - Distinct / Aggregate / StreamAggregate / HashAggregate — restrict to GROUP BY columns; aggregate output columns get no bindings.
  - SetOperation — drop conservatively.
  - Window / AsofScan — pass through (Window) / inherit-left-only (AsofScan), matching FD/EC rules.
- Add cap enforcement to constant-binding merge (`MAX_FDS_PER_NODE`); log truncations under `quereus:planner:fd`.
- Write `test/optimizer/fd-equivalence.spec.ts` per the test list above. Mirror the introspection pattern from `fd-propagation.spec.ts`.
- Update `docs/optimizer.md` with the "Equivalence Classes" subsection covering ECs and constant bindings (including parameters).
- Run build / lint / tests; fix anything that regresses.
