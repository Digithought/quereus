description: Review the covering-structure unification — the `CoveringStructure` enforcement surface, the implicit-reframe of the UNIQUE auto-index, the coverage prover that recognizes an explicit `order by` MV as covering a UNIQUE constraint, eager constraint↔structure linking, and default-hidden introspection. Sound subset only: nothing enforces through an explicit MV's backing table yet (deferred). Treat the tests as a floor; the prover deviates from the original ticket's plan in two ways noted below — verify both are sound.
prereq: materialized-view-core
files: packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/planner/analysis/coverage-prover.ts, packages/quereus/src/planner/analysis/partial-unique-extraction.ts, packages/quereus/src/runtime/emit/materialized-view.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/src/schema/view.ts, packages/quereus/src/schema/table.ts, packages/quereus/src/schema/catalog.ts, packages/quereus/test/covering-structure.spec.ts, docs/materialized-views.md, docs/optimizer.md, docs/lens.md, docs/schema.md
----

## What landed

The sound, shippable subset of the covering-structure arc. **No row-time
enforcement routes through an explicit MV's backing table** — that is unsound
until row-time write-through MV maintenance exists and is deferred to
`backlog/covering-structure-mv-rowtime-enforcement.md` (prereq
`materialized-view-rowtime-write-through`). Physical-schema UNIQUE enforcement is
unchanged (still the synchronously-maintained auto-index).

### Phase A — `CoveringStructure` surface + implicit reframe
- `CoveringStructure` discriminated union exported from `vtab/memory/layer/manager.ts`:
  `{ kind: 'memory-index'; index }` (produced today) | `{ kind: 'materialized-view'; view }`
  (reserved; never returned here — the lens layer compiles against it).
- `findIndexForConstraint` now returns `CoveringStructure | undefined`. Both
  callers updated: `checkSingleUniqueConstraint` switches on `.kind` (the
  `materialized-view` arm throws `StatusCode.UNSUPPORTED` — unreachable today,
  keeps the switch total via a `never` exhaustiveness check); `uniqueColumnsChanged`
  unwraps the `memory-index` before reading `.predicate.referencedColumns`.
- `ensureUniqueConstraintIndexes` still builds the BTree exactly as before
  (observation-equivalent) and additionally records a lightweight implicit-covering
  descriptor (`Map<constraint, {indexName, origin:'implicit-from-unique-constraint'}>`)
  + a public `getImplicitCoveringStructure(uc)` getter.
- New schema fields: `MaterializedViewSchema.origin` + `covers`;
  `UniqueConstraintSchema.coveringStructureName` (forward pointer = source of truth).

### Phase B — coverage prover + eager linkage
- New `planner/analysis/coverage-prover.ts` — `proveCoverage(root, mv, uc, baseTable)`
  → `{covers:true} | {covers:false, reason}`. Reasons: `shape`, `missing-uc-column`,
  `missing-pk-column`, `ordering-mismatch`, `predicate-entailment`, `missing-null-skip`.
- `partial-unique-extraction.ts` now exports `recognizeConjunctiveClauses(expr, tableSchema)`
  (thin wrapper over the existing private recognizer — **no new predicate shapes**) and
  `guardClausesEntail(a, b)` (conservative conjunction entailment).
- Eager prove-and-link in `emitCreateMaterializedView` (`linkCoveredUniqueConstraints`);
  link cleared in `emitDropMaterializedView` (`unlinkCoveredUniqueConstraints`).

### Phase C — introspection hiding
- `collectSchemaCatalog` now **filters out** the auto-index of an inline UNIQUE
  constraint by default (it was previously shown), surfacing it only when the
  constraint carries `quereus.expose_implicit_index = true`. Real `CREATE [UNIQUE]
  INDEX` indexes are always shown.

## ⚠️ Two deliberate deviations from the original plan — verify soundness

1. **Prover reads WHERE + ORDER BY from the body AST, not `mv.ordering` / the
   optimized FilterNode.** The original ticket said "consume `mv.ordering`
   directly" and obtain the predicate from the optimized plan. Empirically the
   optimizer (a) **drops the `Sort`** when an index scan already supplies the
   order — leaving `physical.ordering` (hence `mv.ordering`) undefined — and (b)
   **absorbs a sargable `WHERE` into an index range seek**, deleting the
   `FilterNode`. Both make the optimized plan an *unsound/incomplete* source for
   ordering and predicate (a restricting `where x>0` would read as "no
   predicate" → false Covers). The prover therefore reads `mv.selectAst.orderBy`
   and `mv.selectAst.where` (the faithful, pre-optimization source) and uses the
   optimized plan only for the structural shape walk and the output→base-column
   projection mapping (stable attribute IDs). **Reviewer: confirm the AST is the
   right faithful source and that no canonicalization the prover relies on is
   lost by skipping the optimized predicate.**

2. **Added a completeness direction to predicate alignment.** The ticket's
   literal predicate rules (null-skip + "P entails uc.predicate") are
   *sound-incomplete*: for a full `unique(x,y)` with body `where x>0`, those
   rules alone would wrongly return Covers (the MV omits `x<=0` rows the
   constraint still governs → missed conflicts). The prover additionally requires
   that **P adds no restriction beyond the governed scope** (every P clause is
   entailed by uc.predicate's clauses widened by a permissible NOT-NULL on any UC
   column). Failures reuse reason `predicate-entailment`. **Reviewer: confirm the
   bidirectional check is correct and conservative (false NotCovers only).**

## Soundness model (the load-bearing invariant)

A covering structure must materialize a row set observation-equivalent to the
set the constraint governs: `R_MV == R_C` where `R_C = {rows: uc.predicate holds
(if partial) AND all UC cols non-NULL}`. Completeness (`R_C ⊆ R_MV`) is
non-negotiable — a missing row is a missed conflict. The prover enforces both
containments via `guardClausesEntail` in two directions. A **false Covers is a
latent corruption** once the lens layer makes an explicit MV the sole enforcement
structure; a false NotCovers only forgoes an optimization. Audit the prover with
that asymmetry in mind.

## Use cases / validation (tests are a floor)

New suite `test/covering-structure.spec.ts` (15 cases, all green):
- **Prover positive**: composite `unique(x,y)` with `select x,y,id ... order by x,y`;
  ORDER BY permutation (`order by y,x`); nullable single-col UNIQUE with `where x
  is not null order by x`.
- **Prover negative, one per reason**: `missing-uc-column`, `missing-pk-column`,
  `ordering-mismatch` (no ORDER BY / partial ORDER BY), `predicate-entailment`
  (partial-UNIQUE scope wider; full-UNIQUE restricting filter), `missing-null-skip`,
  `shape` (join body).
- **Eager link**: `coveringStructureName` + `covers` set on create, cleared on
  drop; non-covering MV (no ORDER BY) links nothing.
- **Introspection**: implicit index absent from `collectSchemaCatalog` by default;
  present (named after the constraint) with `quereus.expose_implicit_index = true`.

Regression floor (the implicit reframe must be observation-equivalent):
- `yarn test` (memory) — **3744 passing, 0 failing**.
- `yarn test:store` (LevelDB store path, exercises `quereus-store/store-table.ts`
  UNIQUE enforcement unchanged) — **3740 passing, 0 failing**.
- `yarn workspace @quereus/store test` — **269 passing**.
- `yarn lint` (quereus) — clean. Full monorepo `yarn build` — clean.

## Known gaps / things to probe

- **`findIndexForConstraint` is private** — the "switch is total, returns
  memory-index / undefined" expectation is covered behaviorally (every existing
  UNIQUE suite exercises the memory-index path) and at compile time (`never`
  exhaustiveness), not by a direct unit test. The scan-fallback (`undefined` →
  `checkUniqueByScanning`) is hard to trigger (every UC auto-indexes) and is not
  newly tested. A reviewer wanting a direct test would need to expose the method
  or construct a pathological schema.
- **`getImplicitCoveringStructure` / the manager's `implicitCoveringStructures`
  map are forward-looking scaffolding** the ticket explicitly requested for the
  lens layer; **not consumed by this ticket's own code** (the catalog reconstructs
  the auto-index name independently; `findIndexForConstraint` reads
  `schema.indexes`). The getter is untested and has a benign key-derivation
  mismatch in one unreachable edge (an *unnamed* UC whose matching index
  pre-exists under a different name). Decide whether to keep it now or trim until
  the lens layer needs it.
- **Phase C is a visible behavior change**: inline-UNIQUE auto-indexes that
  previously appeared in `collectSchemaCatalog` / `export_schema` are now hidden
  by default. All declarative/differ tests pass, but confirm no external consumer
  depends on seeing `_uc_*` indexes.
- **Linkage mutates schema objects in place** (`uc.coveringStructureName`,
  `mv.covers`) — consistent with the existing `mv.stale` precedent; UC objects are
  not frozen (only their `columns`/`tags` arrays are). Confirm this is acceptable
  versus a copy-on-write schema replacement.
- **Prover scope is narrow v1** (single-table linear chain, literal projection).
  FD-driven and multi-source coverage are deferred (`backlog/coverage-prover-fd-driven-coverage.md`,
  `backlog/coverage-prover-multi-source-bodies.md` — both verified present).
- **`mv.ordering` is still populated** by `deriveBackingShape` (it seeds the
  backing physical PK) but is **no longer consumed by the prover**. Not removed.

## Follow-ups filed
- `backlog/covering-structure-mv-rowtime-enforcement.md` (NEW) — route row-time
  enforcement through an explicit covering MV; prereq
  `materialized-view-rowtime-write-through` (already in backlog).
- Out-of-scope backlog items verified present: `materialized-view-rowtime-write-through`,
  `coverage-prover-fd-driven-coverage`, `coverage-prover-multi-source-bodies`.
