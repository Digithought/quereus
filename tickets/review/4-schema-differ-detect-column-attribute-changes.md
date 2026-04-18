description: Review declarative schema differ's new column-attribute detection + `ALTER COLUMN` plumbing. Implemented: diff detection (nullability, data type, DEFAULT), parser / AST / planner support for `ALTER TABLE ALTER COLUMN <c> [SET NOT NULL | DROP NOT NULL | SET DATA TYPE <t> | SET DEFAULT <expr> | DROP DEFAULT]`, runtime + module (MemoryTableModule, StoreModule) handling, migration DDL emission, unit & integration tests.
dependencies: declarative schema, ALTER TABLE runtime, StoreModule.alterTable, MemoryTableModule.alterTable
files:
  - packages/quereus/src/schema/schema-differ.ts (ColumnAttributeChange, computeColumnAttributeChange, generateMigrationDDL ordering)
  - packages/quereus/src/schema/catalog.ts (CatalogTable columns now carry defaultValue)
  - packages/quereus/src/parser/ast.ts (alterColumn variant of AlterTableAction)
  - packages/quereus/src/parser/parser.ts (alterColumnAction, parseDataTypeName helpers)
  - packages/quereus/src/emit/ast-stringify.ts (alter column stringifier)
  - packages/quereus/src/planner/nodes/alter-table-node.ts
  - packages/quereus/src/planner/building/alter-table.ts
  - packages/quereus/src/vtab/module.ts (SchemaChangeInfo.alterColumn)
  - packages/quereus/src/runtime/emit/alter-table.ts (runAlterColumn)
  - packages/quereus/src/vtab/memory/module.ts, table.ts, layer/manager.ts (alterColumn case + null-scan backfill + type conversion)
  - packages/quereus-store/src/common/store-module.ts (alterColumn case)
  - packages/quereus-store/src/common/store-table.ts (rowsWithNullAtIndex, mapRowsAtIndex)
  - packages/quereus-isolation/src/isolation-module.ts (pass-through already delegated — unchanged)
  - packages/quereus/test/schema/differ-alter-column.spec.ts (new unit tests)
  - packages/quereus/test/logic/41.2-alter-column.sqllogic (new integration)
  - packages/quereus/test/parser.spec.ts (parser tests appended)
  - packages/quereus/test/schema-differ.spec.ts (existing test updated for new columnsToAlter field)

----

## What was built

`schema-differ.ts` now detects column-attribute drift:

```ts
interface ColumnAttributeChange {
  columnName: string;
  notNull?: boolean;           // omitted = no change
  dataType?: string;
  defaultValue?: AST.Expression | null; // undefined = no change; null = drop
}
```

`TableAlterDiff.columnsToAlter` carries these changes. Detection rules:

- **Nullability**: compared only when declared column specifies explicit NULL/NOT NULL/PK; unspecified columns follow session default and are not flagged.
- **DEFAULT**: AST structural comparison (stable JSON with `loc` stripped). Absent-in-declared + present-in-actual emits `{ defaultValue: null }`.
- **Data type**: case-insensitive name comparison.

`generateMigrationDDL` emits in this order per-alter: ADD COLUMN → ALTER COLUMN (type → default → nullability) → ALTER PRIMARY KEY → DROP COLUMN. This lets a single `apply schema` migrate a backfill-sourced DEFAULT before tightening NOT NULL.

## Runtime & modules

- `runAlterColumn` (`runtime/emit/alter-table.ts`) validates: exactly one attribute populated, PK-column nullability/type changes rejected. Dispatches to `module.alterTable({ type: 'alterColumn', ... })`.
- **MemoryTableManager.alterColumn**:
  - `SET NOT NULL`: scans base-layer rows for NULL; if a literal DEFAULT is present, backfills; else throws CONSTRAINT.
  - `DROP NOT NULL`: schema-only; rejects on PK column.
  - `SET DATA TYPE`: schema-only when physical type matches; otherwise walks rows calling `validateAndParse` to convert, throws MISMATCH on conversion failure.
  - `SET/DROP DEFAULT`: schema-only.
  - Revert path on error mirrors the existing `addColumn`/`dropColumn` pattern.
- **StoreModule.alterTable** gains the same `alterColumn` case, delegating row-walks to two new StoreTable helpers (`rowsWithNullAtIndex`, `mapRowsAtIndex`). DDL persisted via `saveTableDDL`.
- **IsolationModule** pass-through already delegates; no changes required (confirmed by running full test suite with isolation-backed tests).

## Parser

`ALTER TABLE <t> ALTER COLUMN <c>` dispatches to one of:
- `SET NOT NULL` → `{ setNotNull: true }`
- `DROP NOT NULL` → `{ setNotNull: false }`
- `SET DATA TYPE <type>` → `{ setDataType }`
- `SET DEFAULT <expr>` → `{ setDefault: expr }`
- `DROP DEFAULT` → `{ setDefault: null }`

Each statement carries exactly one attribute. Multi-attribute syntax in one statement is not supported by design.

## Use cases / validation

**Unit tests** — `test/schema/differ-alter-column.spec.ts`:
- detects NOT NULL ↔ NULL drift, added/changed/dropped DEFAULT, data-type drift, multi-attribute single-column change.
- generated-DDL ordering test verifies type → default → nullability sequence.
- no-op case emits no `columnsToAlter` entries and no ALTER statements.

**Parser tests** — `test/parser.spec.ts`:
- five subcommand forms parse to expected `alterColumn` action shapes.

**Integration** — `test/logic/41.2-alter-column.sqllogic`:
- DROP NOT NULL then insert NULL succeeds.
- SET NOT NULL with existing NULL rows → CONSTRAINT error.
- SET NOT NULL when no NULLs present → new NULL inserts rejected; existing rows unchanged.
- SET DEFAULT: new inserts pick it up; DROP DEFAULT: omitted column → NULL.
- SET DATA TYPE integer → real preserves numeric row values.
- DROP NOT NULL on PK column → CONSTRAINT error.

## Gates still pending

`allow_destructive` gating from `plan/2-declarative-schema-enhancements.md` is not yet wired to attribute changes. When that lands, destructive cases (SET NOT NULL requiring backfill, narrowing data-type changes) should plug into the same gate. The runtime currently errors on unsafe transitions rather than silently truncating.

## Reviewer focus

- Ordering guarantee in `generateMigrationDDL` for multi-attribute single-column cases.
- Error messages / status codes for constraint and mismatch paths — make sure they match established conventions.
- MemoryTableManager revert-on-error path for `alterColumn` (baseLayer.updateSchema + tableSchema rollback).
- StoreTable.mapRowsAtIndex uses a single batch for the whole table — confirm it's an acceptable blast radius for the intended workloads (matches migrateRows pattern).

## Not done

- SiteCAD `DynamicsSession.playback_time` regression test — SiteCAD lives in a separate repo; the regression test cannot be added from this monorepo.
- `docs/schema.md` unchanged — no existing language describes differ coverage, so no stale statements to update.
