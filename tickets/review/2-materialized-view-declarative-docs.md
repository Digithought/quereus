description: Review the materialized-view declarative-schema integration + documentation layer built on top of materialized-view-core. Adds declared-MV parsing, DDL round-trip through ast-stringify/generateDeclaredDDL, schema-hasher + schema-differ wiring (bodyHash-keyed rebuild), declarative-equivalence coverage, and docs/materialized-views.md plus cross-reference fixups.
files: packages/quereus/src/parser/ast.ts, packages/quereus/src/parser/parser.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/src/schema/view.ts, packages/quereus/src/schema/catalog.ts, packages/quereus/src/schema/schema-hasher.ts, packages/quereus/src/schema/schema-differ.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/test/declarative-equivalence.spec.ts, packages/quereus/test/util/schema-equivalence.ts, packages/quereus/test/schema-differ.spec.ts, packages/quereus/test/schema/differ-alter-column.spec.ts, docs/materialized-views.md, docs/architecture.md, docs/optimizer.md, docs/schema.md, docs/incremental-maintenance.md, docs/lens.md, packages/quereus/README.md
----

## What this ticket delivered

Built the **declarative-schema integration + documentation** layer for materialized
views on top of the `materialized-view-core` substrate (which landed the parser for
top-level `CREATE/REFRESH/DROP MATERIALIZED VIEW`, the `MaterializedViewSchema` with a
populated `bodyHash`, runtime, resolution, and invalidation). Phase-1 MVs are
**manual full-refresh keyed derived relations**; this ticket makes them first-class
citizens of the `declare schema { … } apply schema` pipeline and graduates the design
into prose docs.

### Engine changes

- **Declared-MV AST + parser.** New `DeclaredMaterializedView` item kind
  (`ast.ts`), parsed inside `declare schema { … }` via `declareMaterializedViewItem`
  (`parser.ts`) — accepts `materialized view <name> [(cols)] [using mod(...)] as <body>
  [with tags ...]`. Mirrors `declareViewItem` plus the `using`-clause parsing from the
  top-level `createMaterializedViewStatement`.
- **DDL round-trip.** `createMaterializedViewToString` (pre-existing from core) is now
  wired into `generateDeclaredDDL` (`catalog.ts`) so `apply schema` / export emit
  canonical MV DDL. Also added `declaredMaterializedViewToString` to the
  `declareItemToString` dispatch so a whole `declare schema { … }` statement round-trips
  with an MV in it. Factored a shared `mvModuleClauseToString` helper (used by both the
  top-level and declared emitters) to keep the `using`-clause emission DRY.
- **Catalog.** New `CatalogMaterializedView { name, ddl, bodyHash, tags? }` and a
  `materializedViews` array on `SchemaCatalog`; `collectSchemaCatalog` now collects MVs
  (backing tables remain hidden).
- **Hasher.** `stripTagsFromDeclaredSchema` handles the new item kind; MV bodies feed
  `computeSchemaHash` through `generateDeclaredDDL`.
- **Differ.** `SchemaDiff` gains `materializedViewsToCreate` / `materializedViewsToDrop`.
  The differ creates declared-but-absent MVs, drops absent-from-declared MVs, and on a
  **body change** (declared body hash ≠ live `bodyHash`) schedules a **drop + recreate**.
  `generateMigrationDDL` emits `DROP MATERIALIZED VIEW IF EXISTS` before table drops and
  the `create materialized view …` DDL after tables/views are created. No rename support
  (names are part of the contract, like assertions).
- **bodyHash single source of truth.** Moved the canonical `computeBodyHash`
  (`toBase64Url(fnv1aHash(bodySql))`) into `schema/view.ts` and re-exported it from
  `runtime/emit/materialized-view-helpers.ts`. Both MV creation (stamps `bodyHash`) and
  the differ (recomputes from a declared body) call the same function, so they cannot
  drift. The differ recomputes via `computeBodyHash(astToString(declaredMv.viewStmt.select))`.

### Docs

- New **`docs/materialized-views.md`** — substrate framing (keyed derived relation,
  backing table, dual registration), the three DDL statements, manual-refresh semantics,
  read-only write boundary, query-resolution-to-backing-table, schema-change staleness,
  the PK-from-`keysOf` rule **including the all-columns fallback** and its
  incremental-ineligibility / duplicate-row note, declarative integration, and an
  `## Out of scope / roadmap` section linking the sibling tracks.
- Registered in `docs/architecture.md` (Key Design Decisions bullet) and the
  `packages/quereus/README.md` docs index.
- Cross-referenced from `docs/schema.md` (new `MaterializedViewSchema` key-type entry),
  `docs/optimizer.md`, `docs/incremental-maintenance.md`, and `docs/lens.md`.
- **Fixed the stale `tickets/backlog/known/updatable-views.md` references** (that path no
  longer exists) in `incremental-maintenance.md` (×2), `optimizer.md`, and the
  materialized-view machinery link in `lens.md` — all repointed at
  `docs/materialized-views.md`.

## How to validate

Build / lint / tests were all green at handoff (independently re-runnable):

```
yarn workspace @quereus/quereus build   # exit 0
yarn workspace @quereus/quereus lint    # exit 0
yarn workspace @quereus/quereus test    # 3707 passing / 9 pending / 0 failing
```

(Baseline before this ticket was 3703 passing; the +4 are the new MV cases below.)

### Tests added (treat as a floor, not a ceiling)

`test/declarative-equivalence.spec.ts` → new `describe('declarative-equivalence: materialized views')`:

- **`MV body round-trips through declarative apply (create + refresh)`** — direct DDL vs
  `declare/apply` produce equivalent MV schema (name, columns, **bodyHash**, body AST) and
  identical probe results after a symmetric `INSERT + REFRESH`.
- **`MV over a compound select round-trips`** — self-contained `union all` body (no source
  table), exercising the all-columns-PK fallback path.
- **`changing the MV body triggers a drop+recreate rebuild on re-apply`** — re-declaring
  with a changed body (`select id, x` → `select id, y`) drops+recreates, re-materializes
  from current source, `bodyHash` changes, and the old column is gone.
- **`re-applying an unchanged MV is a no-op and the schema hash is stable`** — asserts
  `diff.materializedViewsToCreate/Drop == []` for an unchanged body, hash stable across
  re-emit, and hash changes on a body change.

Harness support: `assertMaterializedViewSchemaEqual` added to
`test/util/schema-equivalence.ts` (compares name/schema/tags/columns/bodyHash + body AST);
`expectMaterializedViews` field added to the `Case` shape. Existing `SchemaDiff` /
`SchemaCatalog` literals in `schema-differ.spec.ts` and `schema/differ-alter-column.spec.ts`
were updated for the two new diff fields + the catalog field.

### Suggested reviewer probes (not yet covered)

- **`with tags` on a declared MV.** The comparator compares MV tags and the hasher strips
  them, but no test exercises a *tagged* MV round-trip / hash-invariance-under-tags. Worth
  a case.
- **Explicit column-list MV** in declarative form (`materialized view mv (a, b) as …`).
- **`if not exists` / name-clash** interaction through the declarative path.
- **Cross-schema** declared MV (`apply schema other`) — `generateDeclaredDDL` qualifies the
  name; untested end-to-end.

## Known gaps / honest limitations (reviewer: decide minor-fix-inline vs. file-a-ticket)

1. **Migration ordering vs. table ALTER.** `materializedViewsToCreate` runs in the create
   section (after tables/views create, **before** `tablesToAlter`), matching the ticket's
   "like view recreate" guidance. Because an MV recreate *evaluates* its body (unlike a
   view), a rebuild whose **new** body depends on a column added by an `ALTER TABLE` in the
   *same* apply would materialize against the pre-alter shape and fail loudly at apply time.
   Pure body changes (the common case, and what the tests cover) are unaffected. Moving MV
   creates to after the alter loop would close this; left as-is per the ticket's stated
   design.
2. **No MV rename support.** A rename-shaped change is a silent drop+create (losing the
   materialized rows, then re-materializing) — consistent with assertions, but unlike
   tables/views/indexes, `quereus.id` / `previous_name` hints are **not** honored for MVs,
   and `require-hint` policy is **not** enforced for the MV bucket. Intentional v1 scope;
   confirm acceptable.
3. **`getSchemaItem` still not MV-aware** (core finding #8). This ticket made the *differ's*
   catalog (`collectSchemaCatalog`) MV-aware, which is what the declarative pipeline
   consumes. Generic single-item introspection via `getSchemaItem` still surfaces only
   tables/views. Out of this ticket's scope; flag if reviewer wants it folded in.
4. **Backing-module `using` clause** is parsed (top-level and declared) and round-tripped
   but still ignored at runtime (v1 always uses the in-memory module) — inherited from core.
5. **Bag-body duplicate failure** (core's filed `materialized-view-bag-body-duplicates`)
   now also surfaces during a declarative `apply` if a declared MV has a keyless,
   duplicate-producing body — it fails the apply loudly with a raw `UNIQUE constraint
   failed`. Same root cause; tracked there.

## Out of scope (already tracked)

Backlog siblings unchanged by this ticket: `materialized-view-bag-body-duplicates`,
`materialized-view-concurrent-refresh`, `materialized-view-incremental-refresh`,
backing-module pluggability, `materialized-view-writes-through-body`, lens-layer
integration. The new `docs/materialized-views.md#out-of-scope--roadmap` enumerates them.
