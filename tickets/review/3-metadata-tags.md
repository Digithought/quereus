description: Review metadata tags (WITH TAGS) on schema objects
dependencies: none
files:
  - packages/quereus/src/parser/ast.ts
  - packages/quereus/src/parser/parser.ts
  - packages/quereus/src/schema/table.ts
  - packages/quereus/src/schema/column.ts
  - packages/quereus/src/schema/view.ts
  - packages/quereus/src/schema/manager.ts
  - packages/quereus/src/schema/catalog.ts
  - packages/quereus/src/schema/schema-hasher.ts
  - packages/quereus/src/emit/ast-stringify.ts
  - packages/quereus/src/planner/nodes/create-view-node.ts
  - packages/quereus/src/planner/building/create-view.ts
  - packages/quereus/src/runtime/emit/create-view.ts
  - packages/quereus/test/logic/50-metadata-tags.sqllogic
  - docs/sql.md
  - docs/schema.md
---

# Metadata Tags on Schema Objects

Added `WITH TAGS (key = value, ...)` syntax for arbitrary key-value metadata on schema objects. Tags are informational only -- the engine does not derive behavior from them and they do not affect schema hashing.

## What was built

### Syntax support
- Table-level: `CREATE TABLE t (...) WITH TAGS (display_name = 'Orders', audit = true)`
- Column-level: `id INTEGER PRIMARY KEY WITH TAGS (display_name = 'Product ID')`
- Constraint-level (column and table): `CHECK (x > 0) WITH TAGS (error_message = 'Must be positive')`
- View-level: `CREATE VIEW v AS SELECT ... WITH TAGS (cacheable = true)`
- Index-level: `CREATE INDEX idx ON t (col) WITH TAGS (purpose = 'search')`
- `TAGS` is a contextual keyword -- does not break `tags` used as an identifier
- `WITH TAGS` can appear alongside `WITH CONTEXT` in any order
- Tag values: string, number, boolean (true/false), null

### Schema interfaces
- `tags?: Readonly<Record<string, SqlValue>>` added to: TableSchema, ColumnSchema, RowConstraintSchema, ForeignKeyConstraintSchema, UniqueConstraintSchema, IndexSchema, ViewSchema

### AST nodes
- `tags?: Record<string, SqlValue>` added to: CreateTableStmt, ColumnDef, ColumnConstraint, TableConstraint, CreateViewStmt, CreateIndexStmt

### Parser
- `parseTags()` helper parses `(key = value, ...)` after TAGS keyword
- `parseTagValue()` handles string, number, boolean, null, and negative numbers
- Integrated into: `createTableStatement`, `columnDefinition`, `columnConstraint`, `tableConstraint`, `createIndexStatement`, `createViewStatement`, `declareTableItem`, `declareIndexItem`, `declareViewItem`
- Duplicate `WITH TAGS` clause detection

### Schema threading
- Tags threaded through: `buildTableSchemaFromAST`, `columnDefToSchema`, `extractCheckConstraints`, `extractForeignKeys`, `extractUniqueConstraints`, `buildIndexSchema`, `importIndex`, CreateViewNode, and view runtime emitter

### DDL generation
- AST stringifiers emit `with tags (...)` in: column defs, column constraints, table constraints, CREATE TABLE, CREATE INDEX, CREATE VIEW
- `generateTableDDL` (catalog.ts) emits tags from TableSchema for round-trip
- Schema hasher strips tags before computing hash -- tags don't affect versioning

### Programmatic API
- `SchemaManager.getTableTags(tableName, schemaName?)` 
- `SchemaManager.setTableTags(tableName, tags, schemaName?)`

## Testing
- sqllogic test file: `test/logic/50-metadata-tags.sqllogic`
- Covers: table/column/constraint/view/index tags, all value types, combined WITH TAGS + WITH CONTEXT, TAGS as identifier, special string values, CHECK constraint still enforced with tags
- 1416 tests passing, 0 failures
- Build clean

## Key review areas
- Parser: tag parsing at constraint/column/table/view/index levels
- DDL round-trip: tags survive AST stringify and re-parse
- Schema hashing: tags correctly excluded (schema-hasher.ts strips before DDL generation)
- No behavioral changes: tags are strictly informational
