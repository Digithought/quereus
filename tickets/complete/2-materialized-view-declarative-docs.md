description: Materialized-view declarative-schema integration + documentation layer, built on materialized-view-core. Adds declared-MV parsing, DDL round-trip through ast-stringify/generateDeclaredDDL, schema-hasher + schema-differ wiring (bodyHash-keyed drop+recreate rebuild), declarative-equivalence coverage, and docs/materialized-views.md plus cross-reference fixups. Reviewed and completed.
files: packages/quereus/src/parser/ast.ts, packages/quereus/src/parser/parser.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/src/schema/view.ts, packages/quereus/src/schema/catalog.ts, packages/quereus/src/schema/schema-hasher.ts, packages/quereus/src/schema/schema-differ.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/test/declarative-equivalence.spec.ts, packages/quereus/test/util/schema-equivalence.ts, packages/quereus/test/schema-differ.spec.ts, packages/quereus/test/schema/differ-alter-column.spec.ts, docs/materialized-views.md, docs/architecture.md, docs/optimizer.md, docs/schema.md, docs/incremental-maintenance.md, docs/lens.md, packages/quereus/README.md
----

## Summary

Graduated Phase-1 materialized views (manual full-refresh keyed derived relations,
landed by `materialized-view-core`) into first-class `declare schema { … } apply
schema` citizens and into prose docs.

- **Declared-MV AST + parser** — new `DeclaredMaterializedView` item kind, parsed
  inside `declare schema { … }` (`materialized view <name> [(cols)] [using mod(...)]
  as <body> [with tags ...]`), mirroring the top-level `CREATE MATERIALIZED VIEW`.
- **DDL round-trip** — `createMaterializedViewToString` wired into
  `generateDeclaredDDL`; `declaredMaterializedViewToString` added to the
  `declareItemToString` dispatch; shared `mvModuleClauseToString` helper keeps the
  `using`-clause emission DRY across the top-level and declared emitters.
- **Catalog** — `CatalogMaterializedView` + `SchemaCatalog.materializedViews`;
  `collectSchemaCatalog` collects MVs (backing tables stay hidden).
- **Hasher** — `stripTagsFromDeclaredSchema` handles the new kind; MV bodies feed
  `computeSchemaHash` via `generateDeclaredDDL`.
- **Differ** — `SchemaDiff.materializedViewsToCreate/Drop`; creates declared-but-absent,
  drops absent-from-declared, and on a body-hash mismatch schedules a drop+recreate.
  `generateMigrationDDL` emits `DROP MATERIALIZED VIEW IF EXISTS` before table drops and
  the create DDL after tables/views.
- **bodyHash single source of truth** — canonical `computeBodyHash`
  (`toBase64Url(fnv1aHash(astToString(select)))`) moved to `schema/view.ts`, re-exported
  from `runtime/emit/materialized-view-helpers.ts`. MV creation stamps it and the differ
  recomputes it from a declared body through the *same* function, so they cannot drift.
- **Docs** — new `docs/materialized-views.md`; registered in `architecture.md` + README
  docs index; cross-referenced from `schema.md`, `optimizer.md`,
  `incremental-maintenance.md`, `lens.md`; repointed the stale
  `tickets/backlog/known/updatable-views.md` links at `docs/materialized-views.md`.

## How it was validated

```
yarn workspace @quereus/quereus build   # exit 0
yarn workspace @quereus/quereus lint     # exit 0
yarn workspace @quereus/quereus test     # 3709 passing / 9 pending / 0 failing
```

(Was 3707 at implement handoff; +2 from the review-stage tests below.)

## Review findings

Adversarial pass over commit `1503b1e8`. Read the full diff first, then verified
behavior empirically (standalone Node probe against `dist/`) and re-ran build/lint/test.

### What was checked

- **bodyHash drift (the load-bearing invariant).** Confirmed creation
  (`buildCreateMaterializedViewStmt` → `bodySql = astToString(stmt.select)` →
  `computeBodyHash`) and the differ (`computeBodyHash(astToString(declaredMv.viewStmt.select))`)
  hash the *same* canonical form via the one shared `computeBodyHash`. The no-op test
  plus my probe confirm an unchanged body (even when created via `apply schema`, i.e.
  emit→parse→astToString) recomputes the identical hash → no spurious rebuild. The
  single-source-of-truth refactor is sound; the relocated JSDoc on
  `MaterializedViewSchema.bodyHash` now correctly says `toBase64Url(fnv1aHash(...))`
  (the old comment had the composition order backwards).
- **DRY** — `mvModuleClauseToString` correctly shared by both emitters; no duplication.
- **Differ create/drop/rebuild + migration ordering** — drop emitted before table drops,
  create after tables/views (before indexes/assertions). Drop+create both pushed on a
  body change. Logic verified by reading and by the body-change test.
- **Name disjointness** — `addTable`/`addView`/`addMaterializedView` reject cross-kind
  name clashes bidirectionally (schema.ts); matches the doc.
- **Docs accuracy** — read every touched doc against the code. `materialized-views.md`
  matches the implementation (PK inference + all-columns fallback, refresh snapshot
  semantics, read-only write boundary, staleness, declarative rebuild). No stale
  `updatable-views.md` / `tickets/backlog/known` references remain; README's
  `../../docs/` relative path and the `#out-of-scope--roadmap` anchor are correct.
- **Undocumented diff hunk** — `vtab/memory/layer/manager.ts` carries a doc-comment-only
  change (not mentioned in the implement handoff). Verified the corrected claim against
  the code: `replaceBaseLayer` does a synchronous `this.baseLayer = newBase` swap under
  the SchemaChange latch and re-points connections off the old base — so the new
  "readers don't block; start-of-call base snapshot" comment is accurate (the prior
  "readers block on the latch" comment was wrong). Correct, harmless.

### Found and fixed inline (minor)

- **Test coverage gaps** (both flagged by the implementer as uncovered, both probed and
  found *working* — added as regression tests, not bug fixes):
  - `explicit column-list MV round-trips and renames the body columns` — `materialized
    view mv (a, b) as …` through the declarative path; columns rename, no-op diff empty.
  - `tagged MV round-trips and the schema hash is tag-invariant` — `with tags (...)` on a
    declared MV round-trips (comparator checks tags), the schema hash equals the
    untagged-equivalent hash, and re-apply is a no-op.
  - `test/declarative-equivalence.spec.ts`, `describe('declarative-equivalence: materialized views')` → 4 → 6 cases.

### Found, not fixed — intentional v1 scope / already tracked (no new ticket filed)

Each was weighed against "major → file a ticket" and judged minor/intentional:

1. **Migration ordering vs. table ALTER.** MV creates run before `tablesToAlter`. An MV
   recreate whose *new* body depends on a column added by an `ALTER TABLE` in the *same*
   apply would materialize against the pre-alter shape and fail loudly. Pure body changes
   (the common case + all tests) are unaffected. Inherent to the "like view recreate"
   ordering the ticket specified; fails loud, never silently corrupts. Acceptable v1.
2. **No MV rename + `require-hint` not enforced for the MV bucket.** A rename-shaped change
   is a silent drop+create. Because a create re-materializes from current sources, a
   deterministic body reproduces identical rows — the only "loss" is recompute cost, not
   data. Consistent with assertions. Acceptable v1; a future ticket could add policy parity
   if MV materialization cost ever makes silent rebuilds undesirable.
3. **`getSchemaItem` not MV-aware.** This ticket made the *differ's* catalog MV-aware (what
   the declarative pipeline consumes); generic single-item introspection still surfaces
   only tables/views. Out of scope; doesn't affect the declarative path.
4. **`using <module>(...)` parsed/round-tripped but ignored at runtime.** Inherited from
   core; v1 always uses the in-memory module. Documented.
5. **Keyless duplicate-producing body fails apply with raw `UNIQUE constraint failed`.**
   Same root cause as the existing backlog ticket `materialized-view-bag-body-duplicates`;
   tracked there, not re-filed.

### Disposition

No major findings. No new tickets filed — all gaps are either intentional v1 scope
(documented above and in `docs/materialized-views.md#out-of-scope--roadmap`) or already
covered by existing backlog siblings. Minor finding (coverage) fixed inline. Build, lint,
and the full test suite (3709 passing) are green.
