description: Extend declarative schema differ to detect and apply column attribute changes (nullability, data type, DEFAULT) so `apply schema` fully converges a persisted catalog to its declaration. Adds an `alterColumn` variant end-to-end (parser → AST → runtime → StoreModule/MemoryTableModule) plus differ detection and DDL emission.
dependencies: declarative schema, ALTER TABLE runtime, StoreModule.alterTable, MemoryTableModule.alterTable
files:
  - packages/quereus/src/schema/schema-differ.ts (computeTableAlterDiff, TableAlterDiff, generateMigrationDDL)
  - packages/quereus/src/schema/catalog.ts (CatalogTable column shape — extend with defaultValue)
  - packages/quereus/src/schema/ddl-generator.ts (round-trip reference)
  - packages/quereus/src/parser/parser.ts (ALTER COLUMN grammar)
  - packages/quereus/src/parser/ast.ts (AlterTableAction + ColumnDef)
  - packages/quereus/src/vtab/module.ts (SchemaChangeInfo — add alterColumn)
  - packages/quereus/src/runtime/emit/alter-table.ts (runAlterColumn)
  - packages/quereus/src/vtab/memory/module.ts (MemoryTableModule.alterTable)
  - packages/quereus-store/src/common/store-module.ts (StoreModule.alterTable)
  - packages/quereus-isolation/src/isolation-module.ts (pass-through — already delegates)
  - packages/quereus/test/schema/differ-alter-column.test.ts (new)
  - packages/quereus/test/logic/ (integration sqllogic, new file)
  - packages/site-cad/src/test/ (regression for DynamicsSession.playback_time)

---

## Problem

`schema-differ.ts:computeTableAlterDiff` compares declared and actual columns by name only (`new Set(names)`). Attribute changes — nullability, declared type, DEFAULT — are invisible. Running `apply schema` against a previously persisted catalog leaves old column attributes in place indefinitely. SiteCAD hit this when `DynamicsSession.playback_time` stayed NOT NULL after the declared schema softened it to nullable.

## Design

### Interfaces

`TableAlterDiff` gets `columnsToAlter`:

```ts
interface ColumnAttributeChange {
  columnName: string;
  // Only populated fields represent a desired change.
  notNull?: boolean;
  dataType?: string;          // declared (logical) type name
  defaultValue?: AST.Expression | null;  // null = drop, undefined = leave alone
}

interface TableAlterDiff {
  tableName: string;
  columnsToAdd: string[];
  columnsToDrop: string[];
  columnsToAlter: ColumnAttributeChange[];
  primaryKeyChange?: { ... };
}
```

`AlterTableAction` (`parser/ast.ts`) gains an `alterColumn` variant:

```ts
| { type: 'alterColumn'; columnName: string;
    setNotNull?: boolean;        // true = SET NOT NULL, false = DROP NOT NULL
    setDataType?: string;
    setDefault?: AST.Expression | null;  // null = DROP DEFAULT
  }
```

`SchemaChangeInfo` (`vtab/module.ts`) mirrors:

```ts
| { type: 'alterColumn'; columnName: string; change: ColumnAttributeChange }
```

`CatalogTable.columns` must carry `defaultValue?: AST.Expression | null` so the differ can detect DEFAULT drift. Populated from `TableSchema.columns[i].defaultValue` in `tableSchemaToCatalog`.

### Parser

Add to `ALTER TABLE` grammar in `packages/quereus/src/parser/parser.ts`:

```
ALTER TABLE t ALTER COLUMN c SET NOT NULL
ALTER TABLE t ALTER COLUMN c DROP NOT NULL
ALTER TABLE t ALTER COLUMN c SET DATA TYPE <type>
ALTER TABLE t ALTER COLUMN c SET DEFAULT <expr>
ALTER TABLE t ALTER COLUMN c DROP DEFAULT
```

Each subcommand produces a single `alterColumn` action with the matching field populated; the runtime can dispatch based on which field is present. Multiple subcommands on one ALTER COLUMN are **not** supported in v1 (one statement per attribute).

### DDL emission (differ)

`generateMigrationDDL` emits one statement per attribute change:

```
ALTER TABLE t ALTER COLUMN c SET NOT NULL
ALTER TABLE t ALTER COLUMN c DROP NOT NULL
ALTER TABLE t ALTER COLUMN c SET DATA TYPE <type>
ALTER TABLE t ALTER COLUMN c SET DEFAULT <expr>
ALTER TABLE t ALTER COLUMN c DROP DEFAULT
```

Order: column adds → column alters → PK change → column drops (alters stay before drops, so NOT NULL relaxation never blocks a subsequent drop). Within alters: type changes first, then default changes, then nullability (makes SET NOT NULL with DEFAULT backfill usable in one apply).

### Runtime (`runtime/emit/alter-table.ts`)

Add `runAlterColumn(action, ctx)`:

1. Build `SchemaChangeInfo` with the one-attribute `change`.
2. If module exposes `alterTable`, invoke it.
3. Otherwise fall back to the shadow-table rebuild path (same as addColumn today) — re-read rows, construct new TableSchema with the attribute change applied, migrate data through the generic rebuild.
4. Update the in-memory `TableSchema` with the mutation so subsequent statements see the new shape.

### Module implementations

`MemoryTableModule.alterTable` + `StoreModule.alterTable` both gain a case for `alterColumn`:

- **`notNull: false`**: schema-only relaxation; just update the column definition.
- **`notNull: true`**: scan rows for NULLs on this column. If any exist:
  - If `change.defaultValue` also present in the dispatch (combined in the SchemaChangeInfo), backfill rows where the column is NULL using the default expression, then tighten.
  - Otherwise throw `QuereusError(CONSTRAINT, \`column \${columnName} contains NULL values\`)`.
- **`defaultValue`**: schema-only. The stored rows keep their existing values; new inserts get the new default.
- **`dataType`**: compare logical→physical mapping. If identical physical type, schema-only. Otherwise iterate rows and convert each value; on conversion failure (narrowing, NaN, overflow) throw `QuereusError(MISMATCH, ...)` naming row key + column.

Because the runtime emits one statement per attribute, SET NOT NULL + SET DEFAULT come in as two dispatches. The module needs to accept the SET DEFAULT first, update schema metadata, then SET NOT NULL can read that metadata to decide whether backfill is possible without loss. Since the differ orders type → default → nullability, this works without explicit combination logic.

### `allow_destructive` gating

Attribute changes that can lose data (type narrowing, SET NOT NULL when backfill required) participate in the same `allow_destructive` gate introduced by `plan/2-declarative-schema-enhancements.md`. Until that ticket lands, gate behind the same destructive-check function signature so the integration is a no-op seam.

### Isolation

`IsolationModule.alterTable` already pass-through delegates (see current branch diff). Once underlying modules accept the new variant, isolation works unchanged. Verify by running the integration tests with the isolation layer active.

## Tests

### Unit — `packages/quereus/test/schema/differ-alter-column.test.ts`

- Declared `c integer null` vs actual `c integer not null` → diff contains `{ columnName: 'c', notNull: false }`.
- Declared `c integer default 0` vs actual `c integer` → diff contains `{ columnName: 'c', defaultValue: <literal 0 AST node> }`.
- Declared `c integer` vs actual `c integer default 0` → diff contains `{ columnName: 'c', defaultValue: null }` (drop).
- Declared `c real` vs actual `c integer` → diff contains `{ columnName: 'c', dataType: 'real' }`.
- All three at once on one column → all three fields populated on one `ColumnAttributeChange`.
- No-op when attributes match; no entry emitted.
- Rename-only cases still flow through drop+add (explicit rename detection is a different ticket).

### Parser — co-located

- Each of the five subcommand forms parses to the expected `alterColumn` action shape.

### DDL round-trip

- Build declared schema → compute diff against empty catalog → apply DDL → re-collect catalog → re-diff. Second diff must be empty.

### Integration sqllogic — `packages/quereus/test/logic/alter-column.sqllogic`

- Table with `c integer not null`, insert row, redeclare `c integer null`, `apply schema`, `insert … values (null)` succeeds.
- Reverse: table with `c integer null`, insert NULL row, redeclare `c integer not null` → CONSTRAINT error naming column. Add DEFAULT in declaration, re-apply → backfills + succeeds.
- Type widen `integer → real` preserves row values numerically.
- Type narrow `real → integer` with fractional row fails cleanly (MISMATCH), leaves data intact.
- SET DEFAULT on an existing column: new inserts pick up default; existing rows unchanged.
- DROP DEFAULT: new inserts with column omitted produce NULL (assuming column is nullable).

### Regression — SiteCAD

- Persist a catalog with `DynamicsSession.playback_time integer not null`, seed a row, re-declare `playback_time integer null`, re-apply schema, run the `insert or replace` that previously failed. Must succeed. Add under `packages/site-cad/src/test/` with real IndexedDB mock or the existing test store backend (use whatever pattern neighboring tests use — do not add infrastructure).

## Phasing

### Phase 1 — Catalog + differ detection
Extend `CatalogTable.columns[i]` with `defaultValue`. Wire it from `tableSchemaToCatalog`. Extend `TableAlterDiff` + `computeTableAlterDiff` to populate `columnsToAlter`. Unit tests. No runtime wiring yet — differ detection is observable via JSON serialization.

### Phase 2 — AST + parser
Add `alterColumn` variant to `AlterTableAction`. Extend parser rules. Parser tests.

### Phase 3 — Runtime + modules
Add `SchemaChangeInfo.alterColumn` variant. Implement `runAlterColumn` in `runtime/emit/alter-table.ts`. Implement the `alterColumn` case in `MemoryTableModule.alterTable` and `StoreModule.alterTable`. Verify `IsolationModule` pass-through.

### Phase 4 — DDL emission + integration
Update `generateMigrationDDL` to emit the new statements. Wire ordering (type → default → nullability → drops). Integration sqllogic tests. SiteCAD regression.

### Phase 5 — Verify
`yarn build && yarn test` green across monorepo. Lint clean on `packages/quereus`. Update `docs/schema.md` if it documents differ coverage (check first; don't write if unchanged).

## TODO

- Phase 1: extend `CatalogTable.columns[i]` with `defaultValue`; populate from `TableSchema`.
- Phase 1: extend `TableAlterDiff` with `columnsToAlter: ColumnAttributeChange[]`.
- Phase 1: rewrite `computeTableAlterDiff` to detect notNull, dataType, defaultValue drift for surviving columns.
- Phase 1: add `packages/quereus/test/schema/differ-alter-column.test.ts` with the unit cases above.
- Phase 2: add `alterColumn` variant to `AlterTableAction` in `parser/ast.ts`.
- Phase 2: extend `parser.ts` for the five ALTER COLUMN subcommand forms.
- Phase 2: parser tests co-located with existing parser tests.
- Phase 3: add `alterColumn` variant to `SchemaChangeInfo` in `vtab/module.ts`.
- Phase 3: implement `runAlterColumn` in `runtime/emit/alter-table.ts`.
- Phase 3: implement `alterColumn` case in `MemoryTableModule.alterTable`.
- Phase 3: implement `alterColumn` case in `StoreModule.alterTable` (includes null-scan and type-conversion-scan).
- Phase 3: sanity-check `IsolationModule.alterTable` delegation still compiles + passes isolation unit tests.
- Phase 4: extend `generateMigrationDDL` with ALTER COLUMN emission in the right phase order.
- Phase 4: integration sqllogic tests at `packages/quereus/test/logic/alter-column.sqllogic`.
- Phase 4: SiteCAD regression test for `DynamicsSession.playback_time`.
- Phase 5: `yarn build && yarn test` green; `yarn lint` clean in `packages/quereus`.
- Phase 5: review `docs/schema.md` for differ-coverage statements; update if stale.
