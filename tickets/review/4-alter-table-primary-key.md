description: ALTER TABLE ... ALTER PRIMARY KEY support with rebuild fallback
files:
  packages/quereus/src/parser/ast.ts
  packages/quereus/src/parser/parser.ts
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/src/planner/nodes/alter-table-node.ts
  packages/quereus/src/planner/building/alter-table.ts
  packages/quereus/src/runtime/emit/alter-table.ts
  packages/quereus/src/vtab/module.ts
  packages/quereus/src/vtab/memory/module.ts
  packages/quereus/src/vtab/memory/table.ts
  packages/quereus/src/vtab/memory/layer/manager.ts
  packages/quereus/src/vtab/memory/layer/base.ts
  packages/quereus/src/schema/schema-differ.ts
  packages/quereus/src/schema/catalog.ts
  packages/quereus-store/src/common/store-module.ts
  packages/quereus/test/logic/41.1-alter-pk.sqllogic
  packages/quereus/test/logic/50.1-declare-schema-pk.sqllogic
  docs/sql.md
  docs/memory-table.md
  docs/module-authoring.md
---

## What was built

`ALTER TABLE <name> ALTER PRIMARY KEY (<col> [ASC|DESC], ...)` — a first-class DDL statement for changing a table's primary key definition. The empty-PK case `()` is also supported.

### Key design decisions

- **Module contract**: New `SchemaChangeInfo` variant `{ type: 'alterPrimaryKey' }` allows modules to handle re-keying natively. All current modules throw `UNSUPPORTED`, triggering the generic rebuild fallback.
- **MemoryTable rebuild**: Copies rows directly through the manager API (bypassing SQL execution) to avoid transaction-layer isolation issues that arise from nested DDL within a single transaction.
- **Schema differ**: Detects PK changes (column set, order, direction) between declared and actual schemas. Emits `ALTER PRIMARY KEY` statements in the correct order: ADD COLUMN → ALTER PRIMARY KEY → DROP COLUMN.

### Bug fixes discovered during implementation

1. **`MemoryTableManager.renameTable`**: Didn't update `tableSchema.name`, causing subsequent `alterTable` calls to write to the wrong catalog key.
2. **`MemoryTableManager.dropColumn`**: PK definition filter incorrectly removed PK entries that got remapped to the dropped column's index (latent bug, only triggered when PK column index > dropped column index).
3. **`BaseLayer.updateSchema`**: Didn't reinitialize `primaryKeyFunctions`, causing stale PK extractors/comparators after schema changes.

## Testing

### SQL logic tests (`test/logic/41.1-alter-pk.sqllogic`)
- Rekey on empty table
- Rekey on populated table (row count + data preservation)
- Duplicate-key violation during rekey (clean failure, table unchanged)
- Empty PK
- Nullable column rejection
- DESC direction
- Composite PK rekey
- Nonexistent / duplicate column errors
- Parser round-trip

### Declarative schema tests (`test/logic/50.1-declare-schema-pk.sqllogic`)
- `apply schema` that re-keys without column changes (round-trip verification)
- `apply schema` that re-keys AND drops old PK column (combined operation)
- `apply schema` that reorders composite PK columns
- Round-trip: declare → apply → diff is empty

### Full suite
- All 110 logic tests pass
- All unit/spec tests pass across the monorepo
- Build succeeds

## Usage

```sql
-- Change primary key from id to code
ALTER TABLE orders ALTER PRIMARY KEY (code)

-- Composite key with direction
ALTER TABLE events ALTER PRIMARY KEY (year, month DESC)

-- Via declarative schema
DECLARE SCHEMA main {
  TABLE orders (
    code INTEGER PRIMARY KEY,
    description TEXT
  )
}
APPLY SCHEMA main
```
