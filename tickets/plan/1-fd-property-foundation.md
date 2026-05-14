---
description: First-class functional-dependency property on relational plan nodes — data structure, propagation lattice, and closure-on-demand utility
files:
  - packages/quereus/src/planner/nodes/plan-node.ts
  - packages/quereus/src/planner/util/key-utils.ts
  - packages/quereus/src/planner/nodes/filter.ts
  - packages/quereus/src/planner/nodes/project-node.ts
  - packages/quereus/src/planner/nodes/distinct-node.ts
  - packages/quereus/src/planner/nodes/stream-aggregate.ts
  - packages/quereus/src/planner/nodes/hash-aggregate.ts
  - packages/quereus/src/planner/nodes/join-node.ts
  - packages/quereus/src/planner/nodes/bloom-join-node.ts
  - packages/quereus/src/planner/nodes/merge-join-node.ts
  - packages/quereus/src/planner/nodes/set-operation-node.ts
  - packages/quereus/src/planner/nodes/window-node.ts
  - packages/quereus/test/optimizer/fd-propagation.spec.ts
  - docs/architecture.md
  - docs/optimizer.md
---

## Motivation

Quereus currently tracks only one shape of functional dependency: **superkeys**, in two places — `RelationType.keys` (logical, schema-declared) and `PhysicalProperties.uniqueKeys` (derived during physical property computation). Both encode the same statement: "this column set functionally determines every other column."

That's the easy case. Classical relational theory has a strictly more general notion — an **FD set** `F` of pairs `X → Y` saying "any two rows that agree on `X` agree on `Y`." Non-key FDs exist everywhere in real workloads:

- Equality predicates produce constant FDs: `WHERE customer_id = 7` ⇒ `∅ → customer_id`.
- Equi-join predicates produce equivalence FDs: `a.k = b.k` ⇒ `a.k → b.k` ∧ `b.k → a.k`.
- GROUP BY columns determine the aggregate outputs within the same group.
- Foreign-key joins import the parent's key as a derived FD on the child.
- Injective scalar expressions extend determining sets through projection.

Without an FD set, every optimization that *should* look at "what determines what" instead has to look at "is this a full key?" — and a great many real-world rewrites (GROUP BY simplification, ORDER BY pruning, redundant-join elimination, predicate inference) fall outside that narrower question.

This ticket lands the foundation: data structure, basic propagation through the relational operators, and a closure-on-demand helper. It does **not** introduce any consumers — those land in follow-up tickets that reference this one as a prereq.

## Architecture

### Data shape

A new optional field on `PhysicalProperties`:

```typescript
interface FunctionalDependency {
  /** Determinant column indices in the node's output. Empty set means "constant" (no row variation). */
  readonly determinants: readonly number[];
  /** Dependent column indices in the node's output. */
  readonly dependents: readonly number[];
}

interface PhysicalProperties {
  // existing fields ...
  /**
   * Functional dependencies that hold over the output stream. Superkeys
   * (entries in `uniqueKeys`) imply an FD `determinants = key → dependents = all columns`;
   * `fds` carries the additional, non-key dependencies.
   *
   * The set is non-canonical — only the explicit FDs each operator can prove are stored.
   * Use `computeClosure(attrs, fds)` to derive what a set of attributes implies.
   */
  fds?: ReadonlyArray<FunctionalDependency>;
}
```

`uniqueKeys` is **kept as-is** for now — it is load-bearing for existing consumers (`rule-distinct-elimination`, `analyzeJoinKeyCoverage`, `CatalogStatsProvider.joinSelectivity`). The invariant `uniqueKeys[i] ∈ fds with dependents = allCols` is documented but not yet enforced; a future cleanup ticket can collapse the two surfaces once consumers migrate.

Equivalence classes (e.g. `a.k = b.k` after an equi-join) are *expressible* as bi-directional FDs but expensive to discover that way. A small companion field captures them directly:

```typescript
interface PhysicalProperties {
  /**
   * Equivalence classes over the node's output columns. Each class is a set of
   * column indices known to hold equal values for every row. Derived from
   * equality predicates and equi-join conditions.
   */
  equivClasses?: ReadonlyArray<ReadonlyArray<number>>;
}
```

### Propagation rules

Each relational operator's `computePhysical` learns to derive an `fds` (and where applicable, `equivClasses`) field from its children. Conservative default: drop FDs whose attributes don't all survive the operator.

| Operator | FD rule |
| --- | --- |
| **TableReference** | Seed `fds` with `{pk → all-other-columns}` plus one FD per declared `UNIQUE` constraint. |
| **Filter** | Inherit child `fds`. Equality predicate `col = literal` ⇒ add `∅ → col`. Equality `col1 = col2` ⇒ add both directions plus update `equivClasses`. |
| **Project / Returning** | Map FDs through the projection column-mapping. Drop any FD whose determinant or dependent column is not preserved. (Injective-projection extension is a separate ticket — this ticket only handles trivial column-reference preservation.) |
| **Distinct** | Existing all-columns key, plus inherit FDs. |
| **StreamAggregate / HashAggregate** | GROUP BY columns ⇒ FD `groupBy → all-other-columns` (the existing `uniqueKeys` case). Additionally, any FD `X → Y` from the source where `X ⊆ groupBy` survives, with `Y` restricted to columns present in the output. |
| **Inner / Cross Join** | Union both sides' FDs (with right-side indices shifted by left column count). Equi-join columns `a.k = b.k` ⇒ add `a.k → b.k` and `b.k → a.k` and merge the columns into an equivalence class. |
| **Outer Join** | Preserved side's FDs survive on its own attributes (NULL padding does not violate FDs that don't reference the nullable side's columns). Non-preserved side's FDs are dropped — a separate ticket (`fd-outer-join-key-preservation`) refines this. |
| **Semi / Anti Join** | Left side's FDs survive unchanged. |
| **SetOperation** | UNION ALL / EXCEPT ALL: conservatively no FDs. UNION (set semantics) / INTERSECT: all-columns FD only. (A more refined treatment is possible but is deferred.) |
| **Window** | Inherit source FDs. Window-function output columns are not in any new FDs unless the function is provably deterministic over the partition (deferred). |

### Closure-on-demand

The optimizer never materializes the full closure of `F` — that can blow up combinatorially. Instead, consumers call a helper:

```typescript
// in planner/util/fd-utils.ts (new)
/** Returns the set of attributes determined by `attrs` under `fds`. O(|fds| * |attrs|). */
function computeClosure(attrs: ReadonlySet<number>, fds: ReadonlyArray<FunctionalDependency>): Set<number>;

/** True iff `attrs` determines every attribute in `target` under `fds`. */
function determines(attrs: ReadonlySet<number>, target: ReadonlySet<number>, fds: ReadonlyArray<FunctionalDependency>): boolean;

/** Reduce an attribute set to a minimal one that determines the same closure. Used by consumers like GROUP BY simplification. */
function minimalCover(attrs: ReadonlySet<number>, fds: ReadonlyArray<FunctionalDependency>): Set<number>;
```

These live next to the existing `projectKeys` / `combineJoinKeys` / `analyzeJoinKeyCoverage` utilities in `planner/util/key-utils.ts` (or a new `fd-utils.ts` sibling — implementation choice).

### Memory and de-duplication

Each operator's `fds` is constructed from children's `fds` plus a small operator-specific delta. Operators MUST drop redundant FDs cheaply (e.g., when adding `X → Y`, drop any existing `X → Z` where `Z ⊆ Y`). Without this, every join doubles the FD count and the per-node array bloats. The de-dup pass is local — never call `computeClosure` during propagation.

Hard cap: if `fds.length` exceeds `tuning.maxFdsPerNode` (default 64), keep only the FDs whose determinants are subsets of `uniqueKeys` or equivalence-class representatives. This is a safety valve, not a correctness mechanism.

## Use cases enabled (covered by follow-up tickets)

This ticket lands no user-visible behavior. The follow-on tickets that consume `fds`:

- `fd-from-injective-projections` — extend the Project rule to derive new FDs from injective scalar expressions over determining attributes.
- `fd-from-equivalence-classes` — extend the Filter and Join rules to mine all available equalities for FDs and ECs.
- `fd-outer-join-key-preservation` — refine the outer-join rule using FD-aware preservation of the preserved side.
- `rule-groupby-fd-simplification` — drop GROUP BY columns determined by remaining GROUP BY columns.
- `rule-orderby-fd-pruning` — drop ORDER BY trailing keys determined by leading keys.
- `rule-join-elimination-fk-pk` — drop a join whose preserved-side columns are unused and whose FK guarantees ≤1 match.
- `rule-predicate-inference-equivalence` — propagate equalities through ECs (`a = 5 ∧ b = a` ⇒ `b = 5`).
- `fd-change-detection-classification` — extend `analyzeRowSpecific` to classify by FD coverage, not just full-key coverage.
- `fd-view-maintenance-binding-keys` — generalize binding-aware delta planning to FD-determined group keys.

## Tests

Unit tests for the propagation lattice — one per operator — assert the expected FD/EC set on the output. Use `query_plan()` introspection to surface the new properties from SQL-level tests.

Property test additions (in the existing optimizer property suite): for any plan transformation that claims to preserve FDs, validate that the transformed and original plans produce identical results on a synthetic dataset where the claimed FDs hold.

## Documentation

Mandatory updates as part of this ticket:

- **docs/architecture.md** — add a brief mention in "Key Design Decisions" that the engine tracks functional dependencies, not just superkeys, and link to the optimizer doc.
- **docs/optimizer.md** — add a new top-level section "Functional Dependency Tracking" covering the data shape, propagation table, and closure helper. Update the "Key-driven row-count reduction" subsection (currently lines ~1088–1107) to cross-reference the new FD framework. Add `fds` and `equivClasses` to the `PhysicalProperties` interface listing.

## Out of scope

- Migration of `uniqueKeys` consumers to use `fds` directly — they continue to work unchanged.
- FD inference from CHECK constraints (e.g. `CHECK (status IN ('A','B'))` ⇒ bounded domain). Useful but separate.
- FD inference from non-equality predicates (range, IN with multiple values). Doesn't generate FDs in the classical sense.
