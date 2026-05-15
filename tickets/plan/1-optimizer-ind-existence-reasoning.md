---
description: Promote foreign-key declarations to first-class inclusion dependencies in the optimizer and use them for existence-folding rewrites beyond the current join-elimination case — anti-join over a covering FK proves empty, `not exists` folds to false, `exists` to true, FK-covered projections preserve row count.
files:
  - packages/quereus/src/schema/table.ts
  - packages/quereus/src/planner/nodes/plan-node.ts
  - packages/quereus/src/planner/nodes/join-node.ts
  - packages/quereus/src/planner/nodes/join-utils.ts
  - packages/quereus/src/planner/rules/join/
  - packages/quereus/src/planner/rules/subquery/
  - packages/quereus/src/planner/framework/registry.ts
  - packages/quereus/test/optimizer/ind-existence.spec.ts
  - docs/optimizer.md
---

## Problem

A foreign key `child(fk_cols) references parent(pk_cols)` is, formally, an inclusion dependency: every value of `child.fk_cols` exists in `parent.pk_cols`. Quereus already exploits one consequence — FK→PK alignment proves at-most-one-matching, dropping the parent-side of an unused join. But several equally cheap inferences from the same IND are not implemented:

- `select ... from child c where not exists (select 1 from parent p where p.pk = c.fk)` — provably empty when `c.fk` is non-null and FK-covered. Today this still executes the subquery.
- `select ... from child c where exists (select 1 from parent p where p.pk = c.fk)` — provably equivalent to `select ... from child c where c.fk is not null`. Often round-trips to a remote vtab.
- `child c left join parent p on p.pk = c.fk` followed by a filter that's null-tolerant on the parent side — already handled in some shapes; an IND-aware pass generalizes it.
- `select count(*) from child c join parent p on p.pk = c.fk` — equal to `select count(*) from child c where c.fk is not null`, no join needed.

For federated schemas the doc explicitly calls out as Quereus's primary cost lever, each of these eliminates a remote round-trip.

## Architecture

### IND surface

Foreign-key declarations are already in `TableSchema`. Promote them to a per-table `inclusionDependencies` summary the optimizer can index quickly:

```typescript
export interface InclusionDependency {
  readonly childTable: TableReferenceId;        // this side
  readonly childColumns: readonly number[];     // attr ids on child output
  readonly parentTable: TableReferenceId;       // referenced side
  readonly parentColumns: readonly number[];    // attr ids on parent output
  readonly nullable: boolean;                   // any child column nullable?
}
```

This is **not** a per-node physical property like FDs — INDs are global (table-level) facts the rules look up on demand via the schema manager. The reasoning each rule does is local: given a join or subquery shape, is its predicate covered by a known IND?

### Rules to add

All under `planner/rules/`:

1. **`rule-anti-join-fk-empty`** (`rules/subquery/` or `rules/join/`)
   - Pattern: `Antijoin(L, R, p)` where `p` is an equi-join on attrs `(l_cols, r_cols)`, `L.l_cols` are non-null, and an IND `L.l_cols ⊆ R.r_cols` exists.
   - Rewrite: replace with empty relation (preserves L's schema; cardinality 0).
   - Equally: `Filter(L, not exists(Project(Filter(R, R.r = L.l), 1)))` after decorrelation.

2. **`rule-semi-join-fk-trivial`** (mirror of above for `exists`)
   - Pattern: `Semijoin(L, R, p)` with the same IND coverage and non-null `l_cols`.
   - Rewrite: replace with `Filter(L, l_cols is not null)`. If columns are already non-null, drop the filter too.

3. **`rule-fk-covered-inner-join-elim`** (extension of existing join elimination)
   - The current join-elimination rule fires when the parent side is unused above the join. Extend so that **count and aggregate-only references** to the parent side that depend only on existence (not parent column values) also qualify, since the IND guarantees existence iff `child.fk is not null`.

4. **`rule-fk-projection-row-preservation`** (a property, not a rewrite)
   - Inner join on a covering FK with non-null child FK preserves child cardinality. Express this as an annotation on `JoinNode` (`preservesLeftCardinality?: boolean`) so downstream rules (DISTINCT elimination, GROUP-BY simplification, count-pushdown) can use it. No standalone rewrite — it's an enabler.

### Coverage check

Centralize in a helper, e.g. `planner/util/ind-utils.ts`:

```typescript
function isCoveredByInd(
  childAttrs: readonly number[],
  parentAttrs: readonly number[],
  childTable: TableReferenceId,
  parentTable: TableReferenceId,
  schema: SchemaManager,
): { covered: boolean; nullable: boolean }
```

Returns `covered: true` iff there is a declared FK from `childTable.childAttrs` to `parentTable.parentAttrs` (in some declared order; helper handles attr-set permutations). `nullable` reflects whether any child column is nullable, which the consuming rule uses to decide whether to insert a `is not null` guard.

### Interaction with existing decorrelation

The decorrelation rules (EXISTS/IN → semi/anti joins) run before the rules above. The new rules consume the post-decorrelation shapes, so they need to handle:
- Direct semi/anti joins from decorrelation.
- Apply nodes that haven't decorrelated (rare; conservatively skip).

## Test outline (`test/optimizer/ind-existence.spec.ts`)

Schema setup: `parent(id pk, name)`, `child(id pk, parent_id references parent(id) not null)`.

End-to-end via SQL logic + plan-shape assertions:
- `select * from child c where not exists (select 1 from parent p where p.id = c.parent_id)` → plans to empty (constant relation), zero rows, no parent access.
- `select * from child c where exists (select 1 from parent p where p.id = c.parent_id)` → plans to `select * from child` (no parent access; no `is not null` guard since column is non-null).
- Same with nullable FK → plans to `select * from child where parent_id is not null`.
- `select count(*) from child c join parent p on p.id = c.parent_id` → plans to `select count(*) from child where parent_id is not null` (no join).
- Negative case: nullable FK + `not exists` → does NOT fold to empty (because null FK rows match the antijoin).
- Negative case: no FK declared → no folding.
- Multi-column FK works.
- Composite case: `not exists` over a chain of two FK joins folds end-to-end.

Plan-shape tests in `test/plan/joins/` for the rewritten forms.

## Out of scope

- Cross-table assertion-derived INDs (those come via `optimizer-assertion-as-rewrite-premise`).
- IND propagation through derived/projected relations (the rules here look up INDs against the original `TableReferenceNode`s).
- Bounded-cardinality inference from IND chains (e.g., "every order has exactly one customer" combined with cardinality stats) — useful but separate.
- Conditional INDs (FK active only under a discriminator) — separate research-y track.

## TODO (carry to implement)

- Add `InclusionDependency` summary to schema (built from existing FK declarations).
- Implement `isCoveredByInd` helper in `planner/util/ind-utils.ts`.
- Implement four rules listed above; register in `planner/framework/registry.ts`.
- Add `preservesLeftCardinality?` to `JoinNode` (or compute on demand if the existing `cardinalityPolicy` covers it).
- Tests per outline above.
- Update `docs/optimizer.md` with an "Inclusion-dependency reasoning" subsection.
