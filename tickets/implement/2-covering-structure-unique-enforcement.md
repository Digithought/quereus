description: Covering structures — unify UNIQUE enforcement behind one `CoveringStructure` surface. Reframe `LayerManager.ensureUniqueConstraintIndexes`'s auto-built secondary BTree as an *implicit* covering structure described in the materialized-view vocabulary; generalize `findIndexForConstraint` to return a discriminated `CoveringStructure`; add a minimal coverage prover that recognizes when an explicit `create materialized view ... order by` covers a UNIQUE constraint, and eagerly links it. Establishes the "constraint is logical, structure is optional" surface the lens layer consumes — WITHOUT yet routing row-time enforcement through an explicit MV's backing table (that needs row-time write-through maintenance; see Scope note + the deferred backlog item).
prereq: materialized-view-core
files: packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/vtab/memory/index.ts, packages/quereus/src/planner/analysis/coverage-prover.ts, packages/quereus/src/planner/analysis/partial-unique-extraction.ts, packages/quereus/src/planner/analysis/predicate-shape.ts, packages/quereus/src/schema/view.ts, packages/quereus/src/schema/table.ts, packages/quereus/src/schema/catalog.ts, packages/quereus/src/runtime/emit/materialized-view.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus-store/src/common/store-table.ts, docs/materialized-views.md, docs/optimizer.md, docs/lens.md, docs/schema.md
----

## What this ticket is (and what it deliberately is not)

This lands the **sound, shippable subset** of the covering-structure arc:

1. **One enforcement surface.** Re-express the auto-built secondary BTree (today silently created by `ensureUniqueConstraintIndexes`) as an *implicit covering structure*, described in the MV vocabulary, and route enforcement through a uniform `CoveringStructure` value returned by `findIndexForConstraint`. The *physical structure stays the synchronously-maintained BTree* — observation-equivalent, zero behavioral change.
2. **Coverage prover.** Recognize that a user-declared `create materialized view ix_t_xy as select x, y, <pk> from t [where <null-skip>] order by x, y` *covers* `unique(x, y)`, and eagerly record the linkage at MV-creation time. This is pure analysis + schema bookkeeping; nothing enforces through it yet.

It deliberately does **NOT** route row-time UNIQUE enforcement through an explicit MV's *backing table*. See the soundness note below — that path is unsound until row-time write-through MV maintenance exists, and is split out to a deferred follow-up (`covering-structure-mv-rowtime-enforcement`, blocked on `materialized-view-rowtime-write-through` in `backlog/`).

### Soundness note (the reason for the split — read this first)

The parent plan sketched "enforce a UNIQUE constraint by a point-lookup against the covering MV's backing table." That is **not sound under MV-core v1**:

- MV-core materializes the backing table once at `create` / `refresh` (manual refresh). **DML on the source table does not update the backing table** — only DDL marks it `stale`.
- The sibling `materialized-view-incremental-refresh` maintains backing tables **at COMMIT**, not at row-write time. Row-time conflict resolution (`insert or replace` substituting in-place mid-statement, `insert or ignore` skipping) requires the covering structure to be consistent *at the moment of the write*, before commit.

Therefore an explicit MV's backing table cannot drive row-time IGNORE/REPLACE/ABORT today. The synchronously-maintained secondary BTree (today's auto-index) *can*, which is why the implicit-reframe half is sound and ships here, while the explicit-backing-table-enforcement half is deferred.

For **physical** schemas this is moot: every UNIQUE constraint already gets a synchronously-maintained auto-index, so a user's explicit covering MV adds nothing to *enforcement* (it adds a read-answering materialized copy + the recognized linkage). The explicit MV becomes the *sole* covering structure only when the auto-index is retired — which is the **logical-schema** world owned by `lens-prover-and-constraint-attachment` (seq 3). That ticket is where explicit-MV-as-sole-enforcement-structure becomes load-bearing, and it must chain the row-time-maintenance prerequisite.

## Design

### `CoveringStructure` — the unified return shape

`findIndexForConstraint` (today `vtab/memory/layer/manager.ts:848`, returns `MemoryIndex | undefined`) becomes:

```ts
// vtab/memory/layer/manager.ts (or a small sibling module)
export type CoveringStructure =
  | { kind: 'memory-index'; index: MemoryIndex }
  // Produced ONLY once row-time write-through MV maintenance lands.
  // Defined now so the lens layer can pattern-match a stable surface;
  // `findIndexForConstraint` does not return this variant in this ticket.
  | { kind: 'materialized-view'; view: MaterializedViewSchema };

private findIndexForConstraint(targetLayer: Layer, uc: UniqueConstraintSchema): CoveringStructure | undefined;
```

Today it returns only `{ kind: 'memory-index', index }`. The `materialized-view` variant is part of the type (so `lens-prover-and-constraint-attachment` compiles against a stable surface) but is **not produced** here.

Both callers must be updated:
- `checkSingleUniqueConstraint` (`manager.ts:816`) — switch on `.kind`; `memory-index` calls the existing `checkUniqueViaIndex`. A `materialized-view` arm throws `StatusCode.UNSUPPORTED` with a "row-time MV enforcement not yet implemented" message (unreachable today, but keeps the switch total).
- `uniqueColumnsChanged` (`manager.ts:774`) — reads `idx?.predicate?.referencedColumns`. For `memory-index` this is unchanged; pull the `MemoryIndex` out of the `CoveringStructure` before reading `.predicate`.

### Implicit covering structure (the reframe)

`ensureUniqueConstraintIndexes` (`manager.ts:80`) keeps creating the secondary `IndexSchema`/BTree exactly as today — **no migration, no rebuild, no behavior change**. Alongside it, synthesize a descriptor in the MV vocabulary so the implicit and (future) explicit structures share one schema shape:

- On `MaterializedViewSchema` (`schema/view.ts`):
  - `origin: 'explicit' | 'implicit-from-unique-constraint'` (default `'explicit'`; absent on existing serialized MVs ⇒ treat as `'explicit'`).
  - `covers?: { schemaName: string; tableName: string; constraintName?: string }` — back-pointer to the UNIQUE constraint this structure realizes.
- On `UniqueConstraintSchema` (`schema/table.ts`): `coveringStructureName?: string` — forward pointer to the covering MV / index name. (Pick the forward pointer as the source of truth; the MV `covers` back-pointer is the convenience reverse link. Document the choice in `schema.md`.)

The implicit descriptor is **not** registered as a real `MaterializedViewSchema` in `Schema.materializedViews` (it has no backing table of its own — the BTree is the structure). It is a lightweight in-memory association the manager holds so `findIndexForConstraint` and introspection can speak one vocabulary. Keep it cheap: a `Map<constraintName, {indexName, origin}>` on the manager is sufficient; do not over-model.

Default-hidden in introspection: the implicit structure is a backing detail. It is omitted from `collectSchemaCatalog` / `export_schema` by default, surfaced only when the originating constraint carries `quereus.expose_implicit_index = true` (a tag check in `schema/catalog.ts`). Preserves today's user-visible schema shape.

### Coverage prover — `planner/analysis/coverage-prover.ts` (new)

Pure function over a candidate (`MaterializedViewSchema`, `UniqueConstraintSchema`, base `TableSchema`) returning `Covers | NotCovers(reason)`. Input plan: obtain the optimized body root the same way `deriveBackingShape` does — `db.getPlan(mv.selectAst-as-sql).getRelations()[0]` (see `runtime/emit/materialized-view-helpers.ts:41`). Recognition rules (narrow v1):

- Body, after optimization, is a linear chain over the constrained table `T`: `TableReference(T)` → optional `Filter(P)` → `Project(...)` → optional `Sort(...)`. Anything else ⇒ `NotCovers('shape')`.
- The projection's output attributes include every column in `uc.columns` (any order) **and** every PK column of `T` ⇒ else `NotCovers('missing-uc-column')` / `NotCovers('missing-pk-column')`. (PK columns required so the MV row identifies the source row for conflict resolution.)
- NULL-semantics alignment: if any `uc.columns[i]` is nullable, `P` must entail `<col_i> is not null` ⇒ else `NotCovers('missing-null-skip')`. UNIQUE permits multiple NULLs, but a materialized-index point-lookup over NULL keys must not match. All-NOT-NULL UC columns ⇒ no skip required.
- Partial UNIQUE: if `uc.predicate` is non-null, `P` must entail `uc.predicate` ⇒ else `NotCovers('predicate-entailment')`.
- If `order by` is present on the body, its columns must be a permutation of `uc.columns` ⇒ else `NotCovers('ordering-mismatch')`. A missing `order by` is also `NotCovers('ordering-mismatch')` — the prover never invents an ordering. (`MaterializedViewSchema.ordering` already captures the body ordering — consume it directly.)

Predicate entailment helper: `partial-unique-extraction.ts` already classifies predicate shapes into `GuardClause[]` via `recognizeGuardClauses`/`recognizeClause`, but those are **not exported**. Export a thin, side-effect-free wrapper (e.g. `recognizeConjunctiveClauses(expr, tableSchema): GuardClause[] | undefined`) and add a sound, conservative `guardClausesEntail(a: GuardClause[], b: GuardClause[]): boolean` (every clause of `b` is satisfied by some clause of `a`; v1 may require syntactic clause-set superset after normalization — a superset conjunction trivially entails any subset). For the `is not null` case, an `is-null{negated:true}` clause — or any `eq-literal`/`range` clause on the same column — entails not-null. **No new predicate shapes**; reuse `predicate-shape.ts` primitives only.

### Eager prove-and-link at MV creation

In `emitCreateMaterializedView` (`runtime/emit/materialized-view.ts`), after the MV is built and before/at `sm.addMaterializedView(mv)`: for each UNIQUE constraint on each single source table the body reads, run the prover. On `Covers`, set `mv.origin = 'explicit'`, `mv.covers = {...}`, and the constraint's `coveringStructureName`. The emitter already has the optimized body via `deriveBackingShape`; reuse that plan rather than re-planning. Linkage is recorded eagerly so the lens layer and introspection read it without re-proving on every enforcement check. (No enforcement consequence in this ticket — the link is informational until the deferred follow-up + lens ticket consume it.)

Drop / introspection for the linkage:
- `drop materialized view ix_t_xy` (`emitDropMaterializedView`, `materialized-view.ts:129`): if the MV `covers` a constraint, null out that constraint's `coveringStructureName` as part of the drop. (No enforcement demotion yet — physical schemas still enforce via the auto-index.)
- Dropping the source table / constraint: existing teardown already removes the constraint; ensure no dangling `covers` pointer survives in the catalog snapshot.

### Store-path parity (corrected pointer)

The store enforcement path is `packages/quereus-store/src/common/store-table.ts` (`checkUniqueConstraints` / `uniqueColumnsChanged` / `compileFor`), **not** `quereus-plugin-leveldb` (a thin provider over `quereus-store`). It has its own enforcement and does *not* call `findIndexForConstraint`. For this ticket the store path needs **no behavioral change** — the implicit reframe is memory-vtab-internal and observation-equivalent. The only store obligations:
- The new schema fields (`origin` / `covers` / `coveringStructureName`) must not break store schema serialization / round-trip.
- `yarn test:store` stays green (the reframe must not perturb any observable UNIQUE behavior).

Explicit-MV enforcement parity for the store is deferred with the memory side (it lands in the follow-up, where the store's MV-backed lookup is also just a backing-table query through the db — and, because MV backing tables are always the `memory` module in v1, that lookup is module-agnostic).

## Resolved / re-resolved questions

- **Declaration model.** Hybrid leaning explicit, per the lens commitment — unchanged. The legacy auto-index is the implicit covering structure; an explicit covering MV is recognized + linked here, and becomes load-bearing for enforcement only in the logical-schema world (lens ticket), gated on row-time maintenance.
- **Where explicit-MV row-time enforcement lives.** NOT here. It is unsound until row-time write-through MV maintenance exists (distinct from the commit-time `materialized-view-incremental-refresh`). Split to `covering-structure-mv-rowtime-enforcement`, which prereqs `materialized-view-rowtime-write-through` (filed in `backlog/`).
- **Coverage prover scope.** Narrow v1 as above; FD-driven coverage and multi-table MV bodies remain explicit follow-ups (already in `backlog/` per the parent's out-of-scope list — verify they exist or file them).
- **Store module pointer.** `quereus-store/src/common/store-table.ts`, not `quereus-plugin-leveldb`.

## Out of scope (backlog tickets already filed)

- **Row-time write-through MV maintenance** — the prerequisite for explicit-MV enforcement. `backlog/materialized-view-rowtime-write-through.md`.
- **FD-driven covering recognition** — prover generalizes to bodies whose effective key is the constraint columns by FD closure rather than literal projection. `backlog/coverage-prover-fd-driven-coverage.md`.
- **Multi-source covering MVs** — a join MV covering a single-table UC via a single-source binding. `backlog/coverage-prover-multi-source-bodies.md`.

## Key Tests (TDD)

- **Implicit reframe is observation-equivalent (the regression floor).** Every existing UNIQUE test in `test/logic/`, `test/optimizer/`, `test/vtab/` passes unmodified. `insert or {ignore,replace,abort,fail,rollback}`, partial-UNIQUE NULL semantics, composite UNIQUE, PK-change UPDATE conflict diagnostics — all identical before/after. (`test/logic/` + `quereus-store/test/unique-constraints.spec.ts`.)
- **`CoveringStructure` switch is total.** Unit-test that `findIndexForConstraint` returns `{kind:'memory-index'}` for an auto-indexed UC, and `undefined` for a UC with no matching index (scan fallback still fires).
- **Coverage prover — positive.** `create materialized view ix_t_xy as select x, y, id from t order by x, y` ⇒ `Covers` for `unique(x, y)` on `t(id pk, x, y)`. Per-shape goldens (composite, with PK, nullable-with-null-skip).
- **Coverage prover — negative, one test per reason:** missing UC column, missing PK column, `ordering-mismatch` (no `order by` / wrong order), `predicate-entailment` failure (body `where x > 0` vs partial `unique(x,y) where x > 5` — non-entailing direction), `missing-null-skip` (nullable `x` in `unique(x)` with no `where x is not null`).
- **Eager prove-and-link.** After `create materialized view` that covers a UC, the constraint's `coveringStructureName` and the MV's `covers` are populated; after `drop materialized view`, `coveringStructureName` is cleared. (Assert via `db.schemaManager`.)
- **Introspection hiding.** Implicit covering structure absent from `export_schema()` by default; present when the constraint carries `quereus.expose_implicit_index = true`.
- **Store parity.** `yarn test:store` green; the new schema fields round-trip through store schema serialization.

## TODO (implement stage)

Phase A — surface + reframe (sound, shippable; the core deliverable)
- Define `CoveringStructure` (both variants; only `memory-index` produced).
- Generalize `findIndexForConstraint` → `CoveringStructure | undefined`; update both callers (`checkSingleUniqueConstraint`, `uniqueColumnsChanged`); `materialized-view` arm throws UNSUPPORTED.
- Keep `ensureUniqueConstraintIndexes` building the BTree; synthesize the lightweight implicit-covering descriptor + record the constraint↔structure linkage on the manager.
- `MaterializedViewSchema.origin` + `covers`; `UniqueConstraintSchema.coveringStructureName`. Document forward-pointer-as-truth in `schema.md`.

Phase B — coverage prover + linkage
- New `coverage-prover.ts` with the recognition rules above; consume `mv.ordering` and the optimized body root (`db.getPlan(...).getRelations()[0]`).
- Export `recognizeConjunctiveClauses` from `partial-unique-extraction.ts`; add `guardClausesEntail`. No new predicate shapes.
- Eager prove-and-link in `emitCreateMaterializedView`; clear linkage in `emitDropMaterializedView`.

Phase C — introspection
- Default-hide the implicit covering structure in `schema/catalog.ts` / `export_schema`; surface on `quereus.expose_implicit_index = true`.

Phase D — store parity + docs + tests
- Confirm `quereus-store/src/common/store-table.ts` needs no behavioral change; ensure new schema fields round-trip; run `yarn test:store` green.
- `docs/materialized-views.md` (covering section: what "covers" means, prover rules, the soundness boundary), `docs/optimizer.md` (link to prover), `docs/lens.md` (point at the now-shipped `CoveringStructure` surface; note explicit-MV row-time enforcement is gated on row-time write-through), `docs/schema.md` (origin/covers/coveringStructureName + expose tag).
- Run full regression (`yarn test`) + `yarn test:store`; both green.
