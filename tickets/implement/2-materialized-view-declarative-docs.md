description: Materialized views — declarative-schema integration + documentation. Round-trip MV DDL through `ast-stringify` / `generateDeclaredDDL`; teach `schema-differ` + `schema-hasher` to diff/rebuild MVs via the schema's `bodyHash`; declarative-equivalence coverage; new `docs/materialized-views.md`; fix stale cross-references that point at the removed `updatable-views.md`.
prereq: materialized-view-core
files: packages/quereus/src/emit/ast-stringify.ts, packages/quereus/src/schema/catalog.ts, packages/quereus/src/schema/schema-differ.ts, packages/quereus/src/schema/schema-hasher.ts, packages/quereus/src/parser/ast.ts, packages/quereus/test/declarative-equivalence.spec.ts, docs/materialized-views.md, docs/architecture.md, docs/optimizer.md, docs/schema.md, docs/incremental-maintenance.md, docs/lens.md
----

## Scope

The sibling `materialized-view-core` ticket lands the engine substrate (parser, `MaterializedViewSchema` with a populated `bodyHash`, runtime, resolution, invalidation) and the runtime tests. This ticket adds the **declarative-schema integration** and **documentation** layer on top of that shape. It depends on `materialized-view-core` purely for the schema shape and AST types being in place — design as if that ticket has landed.

## Verified codebase anchors (from plan research)

- **View DDL emission**: `createViewToString(stmt: AST.CreateViewStmt)` at `emit/ast-stringify.ts:740-759` emits `CREATE [TEMP] VIEW [IF NOT EXISTS] <name> [(cols)] AS <body> [WITH TAGS ...]`. `ddl-generator.ts` handles only tables/indexes — views (and MVs) round-trip through `ast-stringify`.
- **Declarative DDL generation**: `generateDeclaredDDL(schema)` at `schema/catalog.ts:225-262` walks declared items and calls `createViewToString` for views (`:238-249`).
- **Schema differ**: `schema/schema-differ.ts` — `SchemaDiff` carries `viewsToCreate`/`viewsToDrop` (`:36-48`); views resolve via drop+recreate (`:822-832`). MV support adds parallel `materializedViewsToCreate`/`materializedViewsToDrop` (or reuses the view path with an MV discriminator) and uses `bodyHash` to detect "body changed → rebuild".
- **Schema hasher**: `schema/schema-hasher.ts` — `computeSchemaHash` hashes the whole declared schema's canonical DDL via `fnv1aHash` + `toBase64Url`. `stripTagsFromDeclaredSchema` (`:9`) handles `declaredTable`/`declaredIndex`/`declaredView` item kinds; add a `declaredMaterializedView` kind (or whatever the AST uses for declared MVs) so tags are stripped consistently.
- **Declarative-equivalence harness**: `test/declarative-equivalence.spec.ts` — each `Case` has `directDDL: string[]`, `declarativeBody: string` (inside `declare schema main { ... }`), `probes`, optional `postSetup`.

## Design

### DDL round-trip

Add `createMaterializedViewToString(stmt)` to `emit/ast-stringify.ts` emitting:

```sql
create materialized view [if not exists] <name> [(cols)] as <body> [using <module>(...)] [with tags ...];
```

The body is the retained `selectAst`; reuse the same query-expr stringification `createViewToString` uses. Wire it into `generateDeclaredDDL` (`catalog.ts`) alongside the existing view branch so `declare schema { ... } apply schema` and schema export both emit canonical MV DDL.

### Declarative differ + body-hash

- `declare schema { ... }` accepts `create materialized view`. The AST already exposes a declared-MV item kind (added in `materialized-view-core` parser work, or add the `declared*` wrapper here if the parser only handles top-level `create` — confirm against the AST and the `DeclareSchemaStmt.items` union).
- The differ recognizes a body change via `bodyHash`: when the declared MV's body hash differs from the live MV's `bodyHash`, schedule a **drop + recreate** (the initial-materialization rerun happens as part of recreate, in apply order — a separate transaction deferred to apply time, like view recreate at `schema-differ.ts:822`).
- Hasher: extend `stripTagsFromDeclaredSchema` for the declared-MV item kind so tags don't perturb the schema version, and ensure MV bodies participate in `computeSchemaHash`.

### Documentation

Create **`docs/materialized-views.md`** graduating the design: substrate framing (keyed derived relation, backing table, dual registration), the three DDL statements, manual-refresh semantics, read-only write boundary, query-resolution-to-backing-table, schema-change staleness, the PK-from-`keysOf` rule **including the all-columns fallback** and its incremental-ineligibility note, and an "Out of scope / roadmap" section pointing at the concurrent-refresh, incremental, write-through, and lens siblings.

Register `docs/materialized-views.md` in the docs list in `docs/architecture.md`. Cross-reference it from `docs/optimizer.md`, `docs/schema.md`, `docs/incremental-maintenance.md`, and `docs/lens.md` the way `change-scope.md` / `incremental-maintenance.md` are referenced today.

**Doc fix:** `docs/incremental-maintenance.md`, `docs/optimizer.md`, and `docs/lens.md` reference `tickets/backlog/known/updatable-views.md` as the planned-consumer ticket — that path no longer exists. Repoint those references to `docs/materialized-views.md` (or this ticket's eventual complete summary).

## Key tests

- **DDL round-trip** (`test/declarative-equivalence.spec.ts`): a `Case` whose `declarativeBody` contains `create materialized view mv as select x, y from t` survives schema → DDL emit → parse → schema with no shape change; probes reading `mv` match the direct-DDL DB. Add a body-change case: re-applying a schema with a changed MV body triggers rebuild and the probe reflects the new body.
- Confirm `computeSchemaHash` is stable across re-emit for an unchanged MV and changes when the MV body changes.

## TODO

- `createMaterializedViewToString` in `emit/ast-stringify.ts`; wire into `generateDeclaredDDL` (`catalog.ts`).
- Confirm/parse declared-MV item kind in `DeclareSchemaStmt.items`; extend `stripTagsFromDeclaredSchema` (`schema-hasher.ts`) and ensure MV bodies feed `computeSchemaHash`.
- Differ: `materializedViewsToCreate`/`materializedViewsToDrop` (or MV-aware view path) keyed off `bodyHash`; drop+recreate on body change with deferred re-materialization.
- New `docs/materialized-views.md`; register in `docs/architecture.md`; cross-ref from `optimizer.md`, `schema.md`, `incremental-maintenance.md`, `lens.md`; fix the stale `updatable-views.md` references.
- declarative-equivalence coverage (round-trip + body-change rebuild) + schema-hash stability assertions.
- `yarn workspace @quereus/quereus build` + `test` + lint green; stream long output per AGENTS.md.
