---
description: Derive equivalence classes from equality predicates (Filter) and equi-join conditions (Join), and use them to generate FDs and an `equivClasses` physical property
prereq: fd-property-foundation
files:
  - packages/quereus/src/planner/nodes/filter.ts
  - packages/quereus/src/planner/nodes/join-node.ts
  - packages/quereus/src/planner/nodes/bloom-join-node.ts
  - packages/quereus/src/planner/nodes/merge-join-node.ts
  - packages/quereus/src/planner/analysis/constraint-extractor.ts
  - packages/quereus/src/planner/util/key-utils.ts
  - packages/quereus/test/optimizer/fd-equivalence.spec.ts
  - docs/optimizer.md
---

## Motivation

When a predicate says `a = b`, the planner can treat `a` and `b` as interchangeable for the rest of the query: ordering by either is equivalent, a key on either is a key on the other, an equality on one is an equality on the other. The same holds for the equi-join condition `t.x = u.y` — within the joined relation, `t.x` and `u.y` are guaranteed equal-valued on every emitted row.

Today the planner does not exploit this. `extractConstraints` in `analysis/constraint-extractor.ts` already recognizes equality predicates and emits `coveredKeysByTable` for full-key equality coverage, but it doesn't produce equivalence-class information that survives upward through the plan. `analyzeJoinKeyCoverage` recognizes when equi-pair columns cover a unique key but doesn't expose the per-row column-equality as an equivalence class on the join output.

Equivalence classes unlock three independent optimizations:

- **Predicate inference** (`rule-predicate-inference-equivalence`): `a = 5 ∧ a = b` ⇒ `b = 5`. This produces additional sargable predicates that can be pushed into vtab access plans.
- **Ordering inference**: if the source provides ordering on `a` and the plan has `a = b`, then it also provides ordering on `b` — enabling merge join recognition on the b-side.
- **Key inference**: if `t.x` is a key on `t` and the join condition is `t.x = u.y`, then `u.y` is a key on the join output too. This generalizes the existing `analyzeJoinKeyCoverage` machinery.

## Architecture

### EC representation

A new optional field on `PhysicalProperties` (introduced in `fd-property-foundation`):

```typescript
/**
 * Equivalence classes over the node's output columns. Each class is a maximal
 * set of column indices known to hold equal values for every row in the
 * relation. Singleton classes are not stored.
 *
 * Invariants:
 *   - classes are disjoint (no column appears in two classes)
 *   - every class has size ≥ 2 (singletons are implicit)
 *   - classes are sorted by minimum column index for canonical comparison
 */
equivClasses?: ReadonlyArray<ReadonlyArray<number>>;
```

A small companion structure tracks classes that are bound to a constant — these are full equivalences but with a special "constant member":

```typescript
interface ConstantBinding {
  readonly attrs: readonly number[];          // columns in this class
  readonly value: SqlValue | 'parameter';     // when known statically; 'parameter' for parameter bindings
}
constantBindings?: readonly ConstantBinding[];
```

Constant bindings derive from `WHERE col = literal` and `WHERE col = ?` (parameter, which is constant within a single execution).

### Derivation rules

**Filter** (`nodes/filter.ts:78`): the existing `extractConstraints` call already produces per-column equality info. Extend it to also produce ECs by union-finding over equalities of the form `colA = colB`. Promote `col = literal` to a `ConstantBinding`. Inherit child ECs; merge any new equalities into the existing partition via union-find.

**Inner / Cross Join**: union the left and right ECs (with right indices shifted). For each equi-join pair `(lIdx, rIdx + leftColumnCount)`, merge the two singletons/classes into one. Constant bindings from both sides survive.

**Outer Join**: equi-join columns are *not* equal on null-padded rows. So the equi-join pair does NOT produce an EC on the join output. The preserved side's existing ECs survive on its own columns (those columns are never null-padded). Non-preserved side's ECs survive only when restricted to columns the join can guarantee equal on every emitted row — for a LEFT JOIN, that's an empty set on the right side's columns. (Refinement: a right-side EC `{r1, r2}` survives if both are part of the equi-pair set with corresponding left-side equalities, because in that case the null-padded rows fall under "all null" which is equal under SQL `IS NOT DISTINCT FROM` semantics — but standard SQL `=` returns NULL there. Conservative default: drop right-side ECs on a LEFT JOIN.)

**Project / Returning**: map ECs through the projection column-mapping. A class survives if it has ≥2 surviving members; constant bindings survive if their bound column is projected.

**Distinct / Aggregate**: ECs are preserved when the columns appear in the output. Aggregates: any EC entirely inside the GROUP BY columns survives; aggregate output columns are not in any EC unless deterministic constancy holds (deferred).

**SetOperation**: conservatively drop ECs.

### FD generation from ECs

ECs imply bi-directional FDs: a class `{a, b, c}` ⇒ `a ↔ b`, `b ↔ c`, `a ↔ c`. The FD foundation ticket stores explicit FDs; the EC field gives a more compact representation that the closure helper unpacks on demand. Avoid materializing the implied FDs into the `fds` array — instead, have `computeClosure` / `determines` consult both `fds` and `equivClasses`.

### Constraint extractor integration

`analysis/constraint-extractor.ts` already does per-column equality discovery. The extension:

- A new function `extractEquivClasses(predicate, tableInfos): EquivClassExtraction` that returns `equivClasses` and `constantBindings` for the predicate.
- `computeClosure` and `determines` accept both `fds` and `equivClasses` as inputs.
- `Filter.computePhysical` calls this helper and merges the result with child ECs.

### Cross-table ECs at join boundaries

The equi-join `t.x = u.y` creates an EC `{x_in_output, y_in_output + leftCols}`. If the left side already had `t.x` in an EC `{x, z}`, the merged class is `{x, z, y + leftCols}`. The union-find data structure naturally handles this.

## Use cases enabled

- **Predicate inference rule** (separate ticket): `WHERE t.x = u.y AND t.x = 5` becomes `WHERE t.x = u.y AND t.x = 5 AND u.y = 5`. The added `u.y = 5` is sargable on `u` independently — huge for partitioned and federated data.
- **Ordering inference**: `SELECT * FROM t JOIN u ON t.k = u.k ORDER BY u.k` recognizes the ordering as covered by `t.k`'s monotonicOn — enabling merge join even when only one side is intrinsically ordered.
- **Key inference through joins**: `t.pk = u.fk` and `t.pk` is a key ⇒ `u.fk` is a key on the join output. The existing `analyzeJoinKeyCoverage` only recognizes the cardinality reduction; EC-derived FDs make the structural fact available to downstream rules.
- **Join elimination** (separate ticket): leverages EC to recognize that `t.pk = u.fk` lets the planner substitute one for the other and potentially drop one side.

## Tests

- Unit tests for the EC derivation rules per operator.
- A test asserting that `SELECT * FROM t WHERE id = 5 AND id = ?` produces a constant binding on `id` *and* on `?` (parameter held constant).
- An end-to-end test asserting `WHERE t.k = u.k AND t.k = 5` produces a pushed-down `u.k = 5` predicate (gated on the predicate-inference rule landing, but the EC must be present in `query_plan()` output regardless).
- Property test: for random equality-only predicates over a small column set, the derived EC partition matches a reference union-find implementation.

## Documentation

- **docs/optimizer.md** — add an "Equivalence Classes" subsection in the FD framework area. Document the per-operator derivation rules. Update the "Common Patterns / Predicate Analysis" section to mention EC derivation.
- **docs/architecture.md** — extend the "Attribute-Based Context System" bullet to mention that equality predicates feed an equivalence-class layer used by downstream rules.
