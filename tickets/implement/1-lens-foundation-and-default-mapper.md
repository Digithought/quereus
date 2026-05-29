description: Lens layer foundation — `Schema.kind: 'physical' | 'logical'`, `declare logical schema X { ... }` parser surface, the per-logical-table lens slot, and the default name-based aligner that compiles the inlined effective view body over a default basis. No override syntax, no prover, no module advertisements. Lands the substrate the next two lens tickets build on. Design source: `docs/lens.md`.
prereq: view-updateability-phase-1
files: packages/quereus/src/schema/schema.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/schema/table.ts, packages/quereus/src/schema/lens.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/schema/declared-schema-manager.ts, packages/quereus/src/parser/ast.ts, packages/quereus/src/parser/parser.ts, packages/quereus/src/planner/building/select.ts, packages/quereus/src/runtime/emit/schema-declarative.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/src/schema/catalog.ts, packages/quereus/src/schema/schema-differ.ts, packages/quereus/src/schema/schema-hasher.ts, docs/lens.md, docs/schema.md, docs/architecture.md
effort: xhigh
----

# Lens foundation + default mapper

Lands the substrate from `docs/lens.md`: the `Schema.kind` discriminator, the `declare logical schema X { ... }` parser surface, the per-logical-table **lens slot**, and the **default name-based aligner** that compiles the inlined effective view body. With this in place a logical schema deploys against a name-equivalent basis with **no explicit lens** — the default mapper generates the effective body and the query processor sees an ordinary view.

`docs/lens.md` is the decided source of *intent*; this ticket + the code is the source of *what ships*. Read `docs/lens.md` end-to-end first — especially §§ "Schema Kinds", "The Lens Slot", "The Default Mapper", "Deployment Is a Compile Step", and "Implementation Surface".

Explicit `declare lens for X over Y` overrides land in `lens-explicit-overrides-and-attribute-merge` (already in `plan/`, `prereq:` this slug). The completeness prover + constraint attachment land in `lens-prover-and-constraint-attachment`. Module-level mapping advertisements, multi-source n-way decomposition, and engine-emitted re-decomposition backfill DDL are backlogged (`lens-module-mapping-advertisement`, `lens-multi-source-decomposition`, `lens-re-decomposition-backfill-ddl`).

## Audited code reality (May 2026 — confirmed against HEAD on `view-updates-lens`)

- **`Schema` is a class, not an interface** (`schema/schema.ts:15`), `constructor(name: string)`. `kind` is a constructor parameter + `readonly` field, defaulting to `'physical'`. Call sites that must thread `kind`: `SchemaManager` constructor (`manager.ts:104` — `new Schema('main')` / `new Schema('temp')`, both physical), `SchemaManager.addSchema(name)` (`manager.ts:344` — add an optional `kind` arg), and the two `new Schema(lowerName)` in `importTable` (`manager.ts:~1732`, physical).
- **The declarative pipeline is AST-stored-then-diffed-at-apply, NOT direct schema construction.** `declare schema X { ... }` parses to a `DeclareSchemaStmt` and is stored verbatim in `DeclaredSchemaManager` (`schema/declared-schema-manager.ts`); nothing is registered yet. `apply schema X` (emitter `runtime/emit/schema-declarative.ts` `emitApplySchema`) collects the live catalog (`collectSchemaCatalog`), computes `computeSchemaDiff(declaredSchema, actualCatalog, renamePolicy)`, generates migration DDL (`generateMigrationDDL`), and executes it. **The `kind` discriminator therefore must live on the `DeclareSchemaStmt` AST** (it is the persisted artifact the differ reads), and the runtime `Schema.kind` is set when the schema object is created at apply time.
- **Views resolve via `ViewSchema`, not `TableSchema`.** `select` from a view runs through `schemaManager.getView(schema, name): ViewSchema | undefined` and inlines the body by building `viewSchema.selectAst` (`planner/building/select.ts:385-456`). `TableSchema.isView` / `TableSchema.viewDefinition` exist as fields but are **not** on that inline path (they are vestigial w.r.t. read resolution; `type-utils.ts:62` only reads `isView` for the `isReadOnly` flag). `ViewSchema` (`schema/view.ts:9`) carries `{ name, schemaName, sql, selectAst, columns?, tags? }` — **no constraint surface**. See "Pinned decision: logical-table representation" below — this reconciliation is the #1 thing to get right.
- **The prereq `view-updateability-phase-1`** makes a `ViewSchema`-resolved view writable (single-source projection-and-filter). A logical table that resolves through `getView()` therefore inherits writability for free once that ticket lands. This ticket's bar is read-side + data model + default mapper; mutation through `X.T` rides the view-update path and is not separately built here.
- **`declare schema` parsing** enters at `parser.ts:360` (`DECLARE` → `declareSchemaStatement`); the method body is `parser.ts:2919`, consuming `SCHEMA` at line 2920. The item loop is `parser.ts:2962-2984` (`TABLE` / `INDEX` / `UNIQUE INDEX` / `MATERIALIZED VIEW` / `VIEW` / `SEED` / `ASSERTION`, else ignored). `declareTableItem` (`parser.ts:~3008`) parses the optional `using module(...)` clause.
- **DDL round-trip for `declare schema`** is `emit/ast-stringify.ts` `declareSchemaToString` (`:900`) — **not** `schema/ddl-generator.ts` (that file is `CREATE TABLE` from a `TableSchema`). `catalog.ts` `generateDeclaredDDL` (`:~234`) is the canonical-DDL entry the round-trip test exercises.
- **Differ/hasher** operate on the declared AST + the collected catalog: `schema-differ.ts` `computeSchemaDiff` (item maps built at `:113-136`), `schema-hasher.ts` `computeShortSchemaHash`.
- **`primary key ()`** (empty/singleton key) already round-trips: parser accepts an empty PK column list (`table.ts:526` "An empty column list is fine; means table can have 0-1 rows"), and `ddl-generator.ts:51` emits `PRIMARY KEY ()`. The default mapper inherits this with no special path.

## Pinned decision: logical-table representation

The plan ticket's literal phrasing ("`TableSchema` with `isLogical`, reuse `viewDefinition` for the compiled body, follow the `isView` path") collides with the audited reality that read/write resolution goes through `ViewSchema`/`getView()`, and that `TableSchema.viewDefinition` is not on the inline path. Reconcile as follows (this is the decided approach; deviate only if implementation reveals a strictly DRYer path, and document it in the handoff):

**Register the compiled effective body of each logical table as a `ViewSchema`** (via `schema.addView(...)`) so reads ride `select.ts:385` and writes ride `view-updateability-phase-1` **verbatim, with zero new runtime**. This is exactly `docs/lens.md`'s "the query processor sees an ordinary view."

**Hold the logical spec + lens slot in `schema/lens.ts`**, in a per-`Schema` lens registry keyed by logical table name. The slot is the home for the column/type/constraint surface that the override and prover tickets consume — a `ViewSchema` cannot carry it. The slot stores the logical `TableSchema`-shaped spec (built from the declared `CreateTableStmt` via the existing `columnDefToSchema` / `findPKDefinition` helpers, *without* a `vtabModule`), the resolved basis `SchemaRef`, the compiled body AST, and the constraint list (verbatim; not yet routed to enforcement).

Add `TableSchema.isLogical` and make `vtabModule` optional per the plan, and add `Schema.kind` — these are still needed (catalog/introspection, differ rules, the constraint surface). But the **read/write registration for name `X.T` is the `ViewSchema`** (table/view name-disjointness — `schema.ts:50,100` — forbids registering both a table and a view under one name, so we pick the view). If a later consumer needs the logical `TableSchema` object, it reads it from the lens slot, not from `schema.getTable()`.

> If, while wiring, registering a companion `ViewSchema` proves to fight the differ/catalog round-trip (e.g. the view would be re-diffed as a user view), the fallback is to teach `select.ts` + the view-mutation target resolver to inline a `TableSchema` carrying `isLogical`+`viewDefinition` directly. Prefer the `ViewSchema` path; record which you chose and why in the handoff.

## Schema kind

`Schema.kind: 'physical' | 'logical'`, default `'physical'`. `'logical'` rejects, at parse/apply time, every physical construct: `using module(...)`, `create index` / `unique index`, materialized views, and storage hints. Tags are allowed (engine-facing; survive into the compiled view). Logical tables carry only columns, types, and logical constraints (PK, UNIQUE, CHECK, FK, NOT NULL). Rejections name the offending construct and the logical-schema context.

## Lens slot

```ts
// schema/lens.ts
interface LensSlot {
  logicalTable: TableSchema;          // the logical spec: columns + constraints, vtabModule undefined, isLogical: true
  defaultBasis: SchemaRef;            // resolved basis schema this slot aligns against
  override?: AST.SelectStmt;          // this ticket: always undefined (overrides land next ticket)
  compiledBody: AST.SelectStmt;       // the effective body — populated by the default mapper
  attachedConstraints: ReadonlyArray<LogicalConstraint>; // spec verbatim; routed to enforcement by the prover ticket
}
```

`SchemaRef` / `LogicalConstraint` are small new types in `lens.ts` (a `LogicalConstraint` can be the union of the existing `RowConstraintSchema` / `UniqueConstraintSchema` / `ForeignKeyConstraintSchema` / PK definition already on `TableSchema` — reuse, don't re-model). The slot is populated at lens-compile time (the `apply schema` compile step). For this ticket `override` is always `undefined` and `attachedConstraints` is the spec verbatim.

## Default name-based aligner

`schema/lens-compiler.ts`. Given logical schema `L` and basis schema `B`, produce the inlined effective body per logical table. v1 is **name-based, single-source only**:

For each logical table `L.T`:
1. Find basis table `B.T'` whose name matches (case-insensitive — Quereus lowercases identifiers). No match → error `lens: logical table 'L.T' has no basis backing` (the override surface in the next ticket is where a rename is supplied).
2. For each logical column `L.T.c`, find basis column `B.T'.c` by name. No match → error `lens: logical column 'L.T.c' has no basis backing`.
3. Build the effective body as `select <projected logical columns> from B.T'` (a `SelectStmt` AST over the basis relation, qualified `B.T'`). Emit it via the AST builders / `ast-stringify` so it parses and round-trips like any view body.

**Type/nullability conformance is deferred to the prover ticket.** v1 surfaces the basis type as-is (the projection just selects the basis column) and lets downstream validation catch incompatibilities — do not implement a conformance gate here.

The n-way decomposition shape (`docs/lens.md` § Default Mapper — optional components outer-joined, surrogate shared key, singleton existence relations) is the **future shape, not v1**: v1 is single-source name-equivalent and inherits the singleton case for free (a `primary key ()` logical table over a `primary key ()` basis table is an ordinary single-source projection).

## Default-basis inference (MVP binding)

There is no `declare lens for X over Y` yet, so the basis is inferred at `apply schema X` time: **the single registered physical schema that contains at least one table, excluding the logical schema `X` itself and excluding `temp`.** Concretely, enumerate `schemaManager` schemas; filter to `kind === 'physical'` with ≥1 table; exclude `X` and `temp`.
- Exactly one qualifies → bind to it (this includes `main` when it is the only populated physical schema).
- Zero or more-than-one qualify → error: `lens: cannot infer a default basis for logical schema 'X' (found N candidates); supply 'declare lens for X over <basis>'`.

## Deploy-compile wiring

The lens compile is the `apply schema X` step for a logical schema. In `runtime/emit/schema-declarative.ts` `emitApplySchema`, branch on `declaredSchema` kind:
- **Physical (today's path):** unchanged — diff + migration DDL.
- **Logical:** do **not** generate `create table` DDL for the logical tables. Instead: ensure schema `X` exists with `kind: 'logical'`; resolve the default basis (above); for each declared logical table, run the default mapper to produce the compiled body; populate the lens slot; register the body as a `ViewSchema` under `X.T`. Reject any physical construct found in the declared items (index/MV/`using`) with a named diagnostic.

`declare logical schema` parsing sets the AST flag; the actual schema/object creation happens at `apply schema`, consistent with the existing pipeline. `diff schema X` for a logical schema reports the lens-detach/attach diffs (below), not table DDL.

## Differ / hasher integration

- **`kind`-aware diffing** (`schema-differ.ts`): under a logical declared schema, reject (or never emit) physical-construct diffs; the per-table diff is "attach/detach lens," not "create/drop table."
- **Asymmetric removal** (`docs/lens.md` § Deployment): when a logical table is removed from the declaration, emit a **detach-lens** diff (drop the `ViewSchema` + lens slot) and **never** a drop-basis-table diff. The basis side is unchanged — logical removals never cascade to basis storage.
- **Hash** (`schema-hasher.ts`): extend the deployed-schema hash to cover the logical-side declarations (`kind`, logical tables, their columns/constraints/tags) so a logical change is detected. The basis hash machinery is reused as-is; the asymmetry is that a logical-table removal changes the logical hash but not the basis hash.

Engine-emitted backfill DDL for re-decompositions is **out of scope** (`lens-re-decomposition-backfill-ddl`, backlog) — v1 leaves backfills as the application's responsibility, exactly as the declarative pipeline already supports.

---

## TODO

### Phase A — schema kind + logical-table data model
- [ ] `schema/schema.ts`: add `readonly kind: 'physical' | 'logical'` to the `Schema` class; constructor param defaulting to `'physical'`. Thread through `manager.ts` (`SchemaManager` ctor, `addSchema(name, kind?)`, both `importTable` `new Schema(...)`).
- [ ] `schema/table.ts`: add `isLogical?: boolean`; make `vtabModule` optional (`vtabModule?: AnyVirtualTableModule`). Audit hot consumers of `vtabModule` (analyze, catalog, dml) — logical tables never reach those paths (they register as `ViewSchema`), but keep the type honest.
- [ ] `schema/lens.ts` (new): `LensSlot`, `SchemaRef`, `LogicalConstraint`, plus a per-`Schema` lens-slot registry (a `Map<string, LensSlot>` either on `Schema` or in a sibling manager — match the existing `DeclaredSchemaManager` pattern if a manager is cleaner). Helpers: build the logical `TableSchema` spec from a declared `CreateTableStmt` (reuse `columnDefToSchema` / `findPKDefinition`).

### Phase B — parser + AST + DDL round-trip
- [ ] `parser/ast.ts`: add `isLogical?: boolean` (or `kind?: 'logical'`) to `DeclareSchemaStmt`.
- [ ] `parser/parser.ts`: in `declareSchemaStatement` (`:2919`), accept an optional `LOGICAL` contextual keyword before `SCHEMA` and set the AST flag. (`DECLARE` already dispatches at `:360`.)
- [ ] Build-time / apply-time rejection of physical constructs under a logical declared schema (module association on a `declaredTable`, `declaredIndex`, `declaredMaterializedView`), each with a named diagnostic.
- [ ] `emit/ast-stringify.ts` `declareSchemaToString` (`:900`): emit `declare logical schema ...` when the flag is set, so the DDL round-trips.

### Phase C — default mapper + deploy-compile
- [ ] `schema/lens-compiler.ts` (new): the name-based aligner producing the inlined effective `SelectStmt` per logical table; the failure diagnostics above.
- [ ] Default-basis inference (single populated physical schema in scope; zero/multiple → error with the `declare lens for X over <basis>` hint).
- [ ] Wire compile-at-`apply` in `runtime/emit/schema-declarative.ts` `emitApplySchema`: logical branch builds slots, compiles bodies, registers each `X.T` as a `ViewSchema`, sets `Schema.kind: 'logical'`.

### Phase D — differ / hasher
- [ ] `schema-differ.ts`: `kind`-aware diffing; logical per-table diff is attach/detach-lens; logical removals never emit drop-basis-table.
- [ ] `schema-hasher.ts`: extend hash to cover logical-side declarations; confirm a logical-table removal leaves the basis hash unchanged.
- [ ] `catalog.ts`: ensure `collectSchemaCatalog` / `generateDeclaredDDL` handle a logical schema's view-registered logical tables without mis-classifying them as user views or basis tables (they should round-trip as the logical declaration, not as `create view`).

### Phase E — docs + tests
- [ ] `docs/lens.md`: flip the Implementation Surface entries that ship here from "designed" to "shipped" (schema kind, logical-schema parser, lens slot, default name-based aligner, deploy-compile, asymmetric removal); leave override/prover/advertisement rows as pending.
- [ ] `docs/schema.md`: add the `kind` discriminator and the logical-schema rules (no module, no index, no MV; tags + logical constraints allowed).
- [ ] `docs/architecture.md`: register the lens-foundation chapter in the doc map.
- [ ] Tests (see seeds below).

### Validation
- [ ] `yarn workspace @quereus/quereus run build`, then `yarn test 2>&1 | tee /tmp/lens-test.log; tail -n 100 /tmp/lens-test.log` (stream — never silent-redirect; under Windows+Git Bash the `tee|tail` pipeline can drop stdout, so chain a separate `tail` read).
- [ ] Lint (single-quote globs on Windows).
- [ ] If a failure is plainly pre-existing/unrelated, write `tickets/.pre-existing-error.md` per the stage rules and finish — don't chase it here.

## Key tests (TDD seeds — sqllogic unless noted)

- **Logical-schema declaration parses + applies.** `declare logical schema X { table T (id int primary key); }` then `apply schema X` → schema `X` has `kind: 'logical'`, a lens slot for `T`, no `vtabModule` on the logical spec.
- **Physical-construct rejection.** Under a logical schema, each of (a) `table T (...) using mem()`, (b) a declared `index`/`unique index`, (c) a declared `materialized view` → errors with a diagnostic naming the construct and the logical context. (storage tags remain allowed.)
- **Default mapper aligns identically-shaped logical+basis.** Basis `declare schema Y { table T (id int primary key, name text) using mem(); }` + `declare logical schema X { table T (id int primary key, name text); }` → compiled body `select id, name from Y.T`; `select * from X.T` returns the basis rows.
- **Name mismatch errors.** Logical column absent from basis → compile error naming the column; logical table absent from basis → compile error naming the table.
- **Empty-key / singleton.** `table Config (theme text) ... primary key ()` over a basis `Config(theme text) primary key ()` works end-to-end (single-source projection; no surrogate, no special path).
- **Round-trip** (rides `test/declarative-equivalence.spec.ts`): declare logical schema → emit DDL (`declare logical schema ...`) → re-parse → equivalent.
- **Basis hash asymmetric to logical removals** (unit): drop a logical table from the declaration → basis hash unchanged; differ emits a detach-lens diff, not a drop-basis-table diff.
- **Default-binding inference.** One populated physical schema in scope → auto-binds. Zero or multiple → error whose message contains `declare lens for X over` (the hint).

## Handoff honesty (for the reviewer)

- The logical-table-representation reconciliation (`ViewSchema` registration + `lens.ts` slot for the spec) is the load-bearing decision — verify the chosen path against `select.ts` resolution and the `view-updateability-phase-1` write path, and confirm the differ/catalog do not re-diff the registered body as a user view.
- Mutation through `X.T` is **not** separately built here — it rides `view-updateability-phase-1`. If that prereq's single-source projection path doesn't cover the generated body shape, say so explicitly (it should: the default-mapper body is exactly single-source projection).
- Type/nullability conformance is intentionally **not** gated here (deferred to the prover). v1 surfaces basis types as-is; an incompatible basis column will not error at compile in this ticket.
- n-way decomposition, surrogate keys, outer-joined optional components, module advertisements, and re-decomposition backfill DDL are all **out of scope** and backlogged — flag any place where a stub or a single-source assumption was baked in, so the decomposition ticket knows where to extend.
