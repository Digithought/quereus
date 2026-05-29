description: Review the lens-layer foundation + default name-based mapper. Shipped: `Schema.kind: 'physical' | 'logical'`, the `declare logical schema X { ... }` parser surface + DDL round-trip, the per-`Schema` lens-slot registry (`schema/lens.ts`), the default single-source name-based aligner (`schema/lens-compiler.ts`) wired into `apply schema X`, kind-aware diff/hash with asymmetric removal. A logical schema deploys against a name-equivalent basis with NO explicit lens; the compiled body is registered as an ordinary `ViewSchema` so reads ride the view path. Design source: `docs/lens.md`.
prereq: view-updateability-phase-1
files: packages/quereus/src/schema/lens.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/schema/schema.ts, packages/quereus/src/schema/table.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/schema/schema-differ.ts, packages/quereus/src/schema/schema-hasher.ts, packages/quereus/src/parser/ast.ts, packages/quereus/src/parser/parser.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/src/runtime/emit/schema-declarative.ts, packages/quereus/src/runtime/emit/alter-table.ts, packages/quereus/src/runtime/emit/add-constraint.ts, packages/quereus/src/runtime/emit/analyze.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/test/lens-foundation.spec.ts, packages/quereus/test/logic/51-lens-foundation.sqllogic, docs/lens.md, docs/schema.md, docs/architecture.md
effort: high
----

# Review: Lens foundation + default mapper

Adversarial review of the landed lens substrate. Treat the implementation as a **starting point**, the tests as a **floor**. The next two lens tickets (`lens-explicit-overrides-and-attribute-merge`, `lens-prover-and-constraint-attachment`) build directly on this; a wrong load-bearing decision here costs both.

## What shipped (verify each against the code)

1. **Schema kind** — `Schema.kind: 'physical' | 'logical'` (`schema/schema.ts`), constructor param defaulting `'physical'`, threaded through `SchemaManager.addSchema(name, kind?)`. A per-`Schema` lens-slot registry (`Map<string, LensSlot>`) with `addLensSlot` / `getLensSlot` / `getAllLensSlots` / `removeLensSlot` / `clearLensSlots`; cleared in `removeSchema` / `clearAll`.
2. **Logical-table data model** — `TableSchema.isLogical?: boolean`, `vtabModule?` now optional. New `requireVtabModule(table)` helper in `table.ts` narrows the optional at the ~11 module-backed consumer sites (createIndex, analyze, add-constraint, alter-table ×7, mv-helpers). `SchemaManager.buildLogicalTableSchema(stmt, schemaName)` builds the spec (reusing the existing column/PK/constraint extractors) with `vtabModule: undefined`, `vtabModuleName: ''`, `isLogical: true`.
3. **Lens slot** — `schema/lens.ts`: `LensSlot` (logicalTable spec, `defaultBasis: SchemaRef`, `override?` always undefined this ticket, `compiledBody`, `attachedConstraints`), `LogicalConstraint` union (reuses existing constraint shapes), `buildLogicalConstraints(spec)`.
4. **Parser + round-trip** — `DeclareSchemaStmt.isLogical` (`ast.ts`); `declareSchemaStatement` consumes an optional `LOGICAL` contextual keyword before `SCHEMA` (`parser.ts`); `declareSchemaToString` emits `declare logical schema …` (`ast-stringify.ts`).
5. **Default mapper + deploy** — `schema/lens-compiler.ts`: `deployLogicalSchema` (atomic: compiles all bodies *before* mutating the catalog, then clear-and-rebuild), `validateLogicalDeclaration` (rejects module/index/MV), `inferDefaultBasis` (single populated physical schema, excl. logical + temp; zero/multiple → error with the `declare lens for X over …` hint), `compileDefaultBody` (name-based, single-source; projects exactly the logical columns in declaration order). Wired into `emitApplySchema`'s logical branch (`runtime/emit/schema-declarative.ts`), which returns before the physical diff/migration/seed path.
6. **Differ / hasher** — `computeSchemaDiff` branches on `isLogical` to `computeLogicalSchemaDiff`, populating new `SchemaDiff.lensToAttach` / `lensToDetach` (declared logical tables vs registered views) and **never** `tablesToDrop` (asymmetric removal). `computeSchemaHash` prefixes `logical\n` so a kind flip changes the hash and logical declarations are covered.

## Load-bearing decision to scrutinize (the #1 thing)

**Logical-table representation = registered `ViewSchema` + lens slot for the spec.** I took the pinned-decision path, not the fallback:
- The compiled effective body is registered via `schema.addView(...)`, so `select * from X.T` resolves through `select.ts:392` (the `getView` path) and inlines the body. **Verify**: reads work (covered by `51-lens-foundation.sqllogic` + spec), and the registered body is NOT re-diffed as a user view — because `computeSchemaDiff` branches early on `isLogical` and `apply schema X` for a logical schema never reaches the physical view-diff path.
- The logical `TableSchema` spec (columns/constraints — the surface a `ViewSchema` cannot carry) lives in the lens slot. Override/prover tickets read it from the slot, not `schema.getTable()`.
- **Reviewer check**: confirm there is no consumer that enumerates a logical schema's views and treats them as *user* views (e.g. a schema-introspection TVF). The full suite (3729) passes, but introspection of a logical schema is untested here — see Gaps.

## Mutation is NOT built here (rides the prereq)

`view-updateability-phase-1` was still in `implement/` at the time of writing (designed-as-if-landed per tess rules). Mutation through `X.T` rides that ticket's single-source projection-and-filter path verbatim — the default-mapper body (`select <cols> from B.T'`) is exactly single-source projection, so it should "just work" once the prereq lands. **No write tests exist here** (reads only). When the prereq lands, add write coverage through `X.T` and confirm the generated body shape is accepted by the propagation pass.

## Intentional non-gates / known gaps (flag, don't fix inline unless trivial)

- **Type/nullability conformance is NOT gated** (deferred to `lens-prover-and-constraint-attachment`). `compileDefaultBody` surfaces the basis column type as-is; an incompatible basis column will not error at compile. `attachedConstraints` are stored verbatim, not routed to enforcement.
- **`diff schema X` for a logical schema returns no DDL rows.** `generateMigrationDDL` ignores `lensToAttach`/`lensToDetach` (lens attach/detach happens inside the compiler at apply, not via runnable DDL). The diff *object* carries the lens deltas (unit-tested); the SQL command yields `[]`. Acceptable for MVP — flag if the reviewer thinks `diff` should surface them as informational rows.
- **Re-apply is clear-and-rebuild, not incremental.** Re-applying an unchanged logical schema drops + re-registers every lens view (fires remove/add events). Deterministic and correct; not idempotent at the event level the way the physical no-op path is.
- **Plain `view` / `assertion` / `seed` items in a logical schema are neither rejected nor processed** — only `declaredTable` becomes a lens slot. Out of scope; a future decision point.
- **`vtabModuleName: ''`** on the logical spec (not made optional — only `vtabModule` was, per ticket). Never read for logical tables. Cosmetic.
- **Hash strips tags** (consistent with the existing hasher convention and the declarative-equivalence "tags must not perturb the hash" assertion) — so the ticket's "…/tags" hash wording is satisfied by columns/constraints/kind, not tags. Intentional.
- **n-way decomposition / surrogate keys / outer-joined optional components / module advertisements / re-decomposition backfill DDL** are all out of scope (backlogged). `compileDefaultBody` bakes in the single-source assumption (one basis table per logical table, matched by name) — the decomposition ticket extends here.

## Use cases / validation (the test floor)

`packages/quereus/test/lens-foundation.spec.ts` (17 cases, fresh DB per case) + `packages/quereus/test/logic/51-lens-foundation.sqllogic` (read path through the full SQL harness):

- **Declaration + data model**: `declare logical schema X { table T (id int primary key) }` + `apply` → schema `X` kind `logical`, lens slot for `T`, `vtabModule` undefined on the spec, body registered as a view.
- **Default mapper aligns**: basis `Y.T(id, name)` + logical `X.T(id, name)` → compiled body `select id, name from Y.T`; `select * from X.T` returns basis rows. Extra basis columns are projected away.
- **Name-mismatch errors**: logical column with no basis backing → error naming `X.T.col`; logical table with no basis backing → error naming `X.T`.
- **Empty-key / singleton**: `table Config (theme text) … primary key ()` over a `primary key ()` basis → ordinary single-source projection, no special path.
- **Physical-construct rejection**: module association / `index` / `unique index` / `materialized view` under a logical schema each error naming the construct + the logical context; tags are allowed.
- **Default-basis inference**: one populated physical schema → auto-binds (incl. `main`); zero or multiple → error whose message contains `declare lens for X over`.
- **DDL round-trip**: `declare logical schema` → stringify (`declare logical schema …`) → reparse → `isLogical` preserved + equal hash; a physical schema omits the keyword and hashes differently.
- **Differ asymmetric removal**: drop a logical table from the declaration → `lensToDetach=[t2]`, `lensToAttach=[]`, `tablesToDrop=[]`; basis schema's declared hash unchanged; after apply the lens view is gone but basis `Y.T2` is retained.

**Suggested adversarial probes the reviewer should add** (gaps in my floor): case-insensitive name alignment (mixed-case logical vs basis identifiers); a logical schema whose basis lives in `main` *and* another populated physical schema exists (should error, not silently pick `main`); re-apply that grows a logical table (column added) then shrinks it; `select`ing a logical table whose basis table was later dropped (should surface the same "not found" diagnostic an ordinary view does); a logical column ordering that differs from the basis column ordering (projection must follow logical order — partially covered by the "extra columns" case).

## Validation performed

- `yarn workspace @quereus/quereus run build` — clean. Full `yarn build` (all workspaces) — clean (no downstream consumer references `TableSchema.vtabModule`).
- `yarn workspace @quereus/quereus run test` — **3729 passing, 9 pending, 0 failing** (includes the 18 new lens cases).
- `yarn workspace @quereus/quereus run lint` — clean.
- No `.pre-existing-error.md` written — no unrelated failures surfaced.
