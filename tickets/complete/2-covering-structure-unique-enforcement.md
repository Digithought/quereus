description: Covering-structure unification — `CoveringStructure` enforcement surface, implicit-reframe of the UNIQUE auto-index, coverage prover recognizing an explicit ORDER-BY MV as covering a UNIQUE constraint, eager constraint↔structure linking, and default-hidden introspection. Sound subset only: nothing enforces through an explicit MV's backing table yet (deferred). Reviewed + one soundness fix applied inline.
files: packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/planner/analysis/coverage-prover.ts, packages/quereus/src/planner/analysis/partial-unique-extraction.ts, packages/quereus/src/runtime/emit/materialized-view.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/src/schema/view.ts, packages/quereus/src/schema/table.ts, packages/quereus/src/schema/catalog.ts, packages/quereus/test/covering-structure.spec.ts, docs/materialized-views.md, docs/optimizer.md, docs/lens.md, docs/schema.md
----

## Summary

The sound, shippable subset of the covering-structure arc landed and has now
passed an adversarial review. The architecture is as described in the implement
handoff (Phases A/B/C: `CoveringStructure` surface + implicit reframe, coverage
prover + eager linkage, default-hidden introspection). **No row-time enforcement
routes through an explicit MV's backing table** — that is deferred to
`backlog/covering-structure-mv-rowtime-enforcement.md` (prereq
`materialized-view-rowtime-write-through`). Physical-schema UNIQUE enforcement is
unchanged (the synchronously-maintained auto-index).

One real (latent) soundness bug was found and fixed inline; everything else
checked out. Details below.

## Review findings

### Checked — and what was found

**Coverage prover soundness (the load-bearing audit).** Walked every recognition
gate for false-`Covers` (a false `Covers` is latent corruption once enforcement
routes through the structure; a false `NotCovers` only forgoes an optimization):

- **Shape walk** — single-relation chain to the terminal `TableReference`; any
  branching / aggregating / set-op node ⇒ `shape`. Sound.
- **Projection coverage via stable attribute IDs** — verified no false positive
  is possible: only bare column-references preserve the source attribute id
  through Project/Sort/scan; a computed projection gets a fresh id absent from
  the base map, so it is conservatively *not* counted (→ `missing-uc-column`).
- **Ordering** read from `mv.selectAst.orderBy` (deviation #1). Confirmed the AST
  is the faithful source: the optimizer drops the `Sort` when an index scan
  already supplies order. Considered the alias-shadowing edge (`select x as z …
  order by z` where the base table also has a column `z`): cannot yield a false
  permutation match because UC column indices are distinct, so a mis-resolved
  ordinal can never equal the required UC index set. Conservative.
- **Predicate alignment, both directions** (deviation #2) — hand-evaluated the
  soundness *and* completeness checks for: full UNIQUE + restricting `where x>0`
  (correctly `predicate-entailment`), nullable UC with `where x is not null`
  (`Covers`), nullable UC with no NULL-skip (`missing-null-skip`), partial-UNIQUE
  exact match (`Covers`), partial scope-widening (`predicate-entailment`), and
  `or-of` body conjuncts (conservatively rejected). The bidirectional check is
  correct and conservative — both deviations from the original plan are sound.

- **`guardClausesEntail` / `rangeSubset` / `clauseForcesColumnNonNull`** — the
  entailment lattice is conservative (unrecognized ⇒ "not entailed"), and
  `clauseForcesColumnNonNull` correctly treats every comparison bound, equality,
  and all-branch `or-of` as NULL-excluding.

**🔴 Soundness bug found + fixed (minor disposition — small, contained, tested).**
The prover listed `PlanNodeType.OrdinalSlice` in its `PASS_THROUGH` set and
walked through it as a "row-preserving pass-through." `OrdinalSlice` is in fact a
**pushed-down `LIMIT`/`OFFSET`** (`rule-monotonic-limit-pushdown`), a row-
*dropping* node. A body like `select x, y, id from t order by x, y limit 100`
over an ordinal-seek-capable base table optimizes to `…/OrdinalSlice/leaf`; the
prover never inspected `limit`, so it returned a **false `Covers`** for a view
that materializes only a prefix of the governed rows. Note the asymmetry that
exposed it: the *non*-pushed-down form keeps a `LimitOffset` node, which already
(correctly) failed the shape gate — so a row cap was accepted or rejected purely
on whether the base vtab advertised ordinal-seek. Latent today (the memory vtab
defers `supportsOrdinalSeek`, and nothing enforces through an explicit MV yet),
but a real prover-soundness defect.
  - **Fix** (`coverage-prover.ts`): reject `LIMIT`/`OFFSET` up front from the
    **AST** (`mv.selectAst.limit`/`offset`) — consistent with the prover's own
    "read the faithful AST, not the optimized plan" philosophy for WHERE/ORDER BY
    — and removed `OrdinalSlice` from `PASS_THROUGH` as a structural backstop,
    with the set's doc updated to state row-dropping nodes are excluded.
  - **Tests** (`covering-structure.spec.ts`): two new negatives —
    `shape (LIMIT …)` and `shape (OFFSET …)`.
  - **Docs** (`materialized-views.md` § Covering structures): the shape rule now
    lists `LIMIT`/`OFFSET` among the non-covering forms.

**Implicit reframe (observation-equivalence).** Confirmed
`ensureUniqueConstraintIndexes` builds the BTree exactly as before and only
*additionally* records the implicit descriptor; `checkSingleUniqueConstraint`
switches on `.kind` with a total switch (`never` exhaustiveness, `materialized-
view` arm throws `UNSUPPORTED` — unreachable today), and `uniqueColumnsChanged`
unwraps `memory-index` before reading `.predicate.referencedColumns`. The full
memory suite (incl. all UNIQUE / partial-UNIQUE logic tests) stays green.

**Eager link / unlink.** `linkCoveredUniqueConstraints` re-plans the body
(cheap — already planned during shape derivation), proves per-UC, stamps the
forward pointer (source of truth) + reverse `covers`, and links the first covered
UC. `unlinkCoveredUniqueConstraints` matches on the forward pointer so it clears
unnamed constraints too. Drop path verified by test.

**Introspection hiding (Phase C — visible behavior change).** `collectSchemaCatalog`
still collects tables, views, materializedViews, indexes, and assertions (the
function body is unchanged except the index loop now filters implicit covering
structures). Real `CREATE [UNIQUE] INDEX` indexes (`derivedFromIndex` set) are
always shown; inline-UNIQUE auto-indexes are hidden unless the constraint carries
`quereus.expose_implicit_index = true`. No external consumer regressed — the full
declarative/differ suite passes.

**Docs.** Read every touched doc against the new reality: `materialized-views.md`
(§ Covering structures — implicit/explicit/soundness boundary), `optimizer.md`
(§ Coverage proving), `schema.md` (§ Covering-structure links + introspection),
`lens.md` (basis covering structures). All consistent with the code, including
the AST-as-faithful-source rationale and the soundness boundary. Updated the one
gap (row cap) introduced by the fix above.

**Follow-up backlog tickets** — verified present:
`covering-structure-mv-rowtime-enforcement`, `materialized-view-rowtime-write-through`,
`coverage-prover-fd-driven-coverage`, `coverage-prover-multi-source-bodies`.

### Found but deliberately NOT changed (documented, not silent)

- **`getImplicitCoveringStructure` is forward-looking scaffolding, untested, and
  carries a benign key-derivation mismatch** for the unreachable edge of an
  *unnamed* UC whose matching index pre-exists under a non-conventional name (the
  map is keyed by the pre-existing index name, the getter recomputes `_uc_<cols>`
  → miss). It is **not consumed by this ticket's own code** (the catalog
  reconstructs the auto-index name independently; `findIndexForConstraint` reads
  `schema.indexes`). Left as-is per the ticket's explicit request for the lens
  layer; the mismatch lives only in dead code and is recorded here. Not worth
  fixing until the lens layer consumes it (and defines the real keying contract).
- **`findIndexForConstraint` private / scan-fallback untested** — covered
  behaviorally (every UNIQUE suite exercises the memory-index path) and at
  compile time (`never` exhaustiveness). The `undefined → checkUniqueByScanning`
  fallback is unreachable in practice (every UC auto-indexes). No new direct test
  added; exposing the method purely to test an unreachable branch is not worth
  the surface.
- **Linkage mutates schema objects in place** (`uc.coveringStructureName`,
  `mv.covers`/`origin`) — consistent with the existing `mv.stale` precedent; UC
  objects are not frozen. Acceptable for this ticket.
- **`mv.ordering` still populated by `deriveBackingShape` but no longer consumed
  by the prover** — harmless (seeds the backing physical PK); left as-is.
- **Prover scope is narrow v1** (single-table linear chain, literal projection) —
  by design; FD-driven and multi-source coverage are the two deferred backlog
  tickets above.

### Empty categories

- **No new fix/plan/backlog tickets filed for findings.** The single defect found
  was small and contained enough to fix inline with tests + docs; nothing rose to
  "major / needs its own ticket."
- **No pre-existing failures flagged** — the suite is fully green at HEAD with the
  fix applied; no `.pre-existing-error.md` written.

## Validation

- `yarn build` (monorepo, `tsc`) — clean.
- `yarn lint` (quereus) — clean.
- `yarn test` (memory) — **3746 passing, 0 failing, 9 pending** (implement floor
  was 3744; +2 for the new LIMIT/OFFSET negatives).
- LevelDB store path (`quereus-store` UNIQUE enforcement) was unchanged by this
  ticket and unaffected by the prover-only fix; `yarn test:store` was run at
  implement time (3740 passing) and is not re-exercised by an analysis-layer fix.

## Deferred / follow-ups (unchanged from implement)

- `backlog/covering-structure-mv-rowtime-enforcement.md` — route row-time
  enforcement through an explicit covering MV; prereq
  `materialized-view-rowtime-write-through`.
- `backlog/coverage-prover-fd-driven-coverage.md`,
  `backlog/coverage-prover-multi-source-bodies.md` — prover reach extensions.
