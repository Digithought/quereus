---
description: Add arbitrary key-value metadata tags (WITH TAGS) to schema objects (tables, columns, constraints, views, indexes)
dependencies: none
files:
  - packages/quereus/src/parser/ast.ts
  - packages/quereus/src/parser/lexer.ts
  - packages/quereus/src/parser/parser.ts
  - packages/quereus/src/schema/table.ts
  - packages/quereus/src/schema/column.ts
  - packages/quereus/src/schema/view.ts
  - packages/quereus/src/schema/manager.ts
  - packages/quereus/src/schema/catalog.ts
  - packages/quereus/src/schema/schema-hasher.ts
---

# Metadata Tags on Schema Objects

Inspired by D4's metadata tags, add support for arbitrary key-value metadata on schema objects. Tags are informational only — the engine does not derive behavior from them. They do not affect schema hashing.

## Syntax

```sql
-- Table-level tags
create table Orders (
  id integer primary key,
  name text not null
) with tags (display_name = 'Customer Orders', audit = true);

-- Column-level tags
create table Products (
  id integer primary key with tags (display_name = 'Product ID'),
  name text not null with tags (searchable = true, display_name = 'Product Name')
);

-- Constraint-level tags
create table Employees (
  id integer primary key,
  email text not null,
  constraint uq_email unique (email) with tags (error_message = 'Email must be unique')
);

-- Column constraint-level tags
create table Items (
  id integer primary key,
  quantity integer not null check (quantity > 0) with tags (error_message = 'Quantity must be positive')
);

-- View-level tags
create view ActiveUsers as select * from Users where active = 1
  with tags (cacheable = true);

-- Index-level tags
create index idx_name on Products (name) with tags (purpose = 'search optimization');
```

Tag values are `SqlValue` (string, number, boolean, null). Tag keys are identifiers. `WITH TAGS` can appear alongside other `WITH` clauses (e.g. `WITH CONTEXT`) in any order — the existing `parseTrailingWithClauses()` pattern at parser.ts:3163 handles this already.

For column-level and constraint-level tags, `WITH TAGS (...)` appears after all other constraint modifiers (after ON CONFLICT, after DEFERRABLE, etc.), using the same trailing position pattern.

## Schema Representation

A `tags` field on each schema interface. Type: `Readonly<Record<string, SqlValue>>`. Undefined when no tags are present.

### Interfaces to modify

- `TableSchema` (table.ts:19) — add `tags?: Readonly<Record<string, SqlValue>>`
- `ColumnSchema` (column.ts:8) — same
- `RowConstraintSchema` (table.ts:296) — same
- `ForeignKeyConstraintSchema` (table.ts:312) — same
- `UniqueConstraintSchema` (table.ts:368) — same
- `IndexSchema` (table.ts:210) — same
- `ViewSchema` (view.ts:7) — same

### AST nodes to modify

- `CreateTableStmt` (ast.ts:257) — add `tags?: Record<string, SqlValue>`
- `ColumnDef` (ast.ts:394) — add `tags?: Record<string, SqlValue>`
- `ColumnConstraint` (ast.ts:414) — add `tags?: Record<string, SqlValue>`
- `TableConstraint` (ast.ts:432) — add `tags?: Record<string, SqlValue>`
- `CreateViewStmt` (ast.ts:288) — add `tags?: Record<string, SqlValue>`
- `CreateIndexStmt` (ast.ts:270) — add `tags?: Record<string, SqlValue>`

## Parser Changes

### Shared helper

Add a `parseTags(): Record<string, SqlValue>` method that parses `(key = value, ...)` after the `TAGS` keyword has been consumed. Keys are identifiers. Values are literals (string, number, boolean via `TRUE`/`FALSE`, `NULL`).

### Integration points

1. **`parseTrailingWithClauses()`** (parser.ts:3163) — add `WITH TAGS` as a third branch alongside `WITH CONTEXT` and `WITH SCHEMA`. This handles table-level and statement-level tags with no ordering requirements.

2. **`columnConstraint()`** (parser.ts:3221) — after parsing each constraint's modifiers (ON CONFLICT, DEFERRABLE, etc.), check for trailing `WITH TAGS (...)` and attach to the constraint AST node.

3. **`columnDefinition()`** (parser.ts:3060) — after parsing the constraint list, check for column-level `WITH TAGS (...)` and attach to the `ColumnDef` AST node.

4. **`tableConstraint()`** (parser.ts:3311) — same as column constraint — check for trailing `WITH TAGS`.

5. **`createIndexStatement()`** — after WHERE clause parsing, check for `WITH TAGS`.

6. **`createViewStatement()`** — parse trailing `WITH TAGS` after the SELECT body. Use the trailing-with-clauses pattern or a direct check since views don't currently have other WITH clauses.

### TAGS as contextual keyword

`TAGS` should be a contextual keyword (like `SCHEMA`, `SEED`) — not added to the reserved KEYWORDS map so it doesn't break identifiers named "tags".

## Schema Manager Changes

### `buildTableSchemaFromAST()` (manager.ts:748)

Thread `stmt.tags` through to the `TableSchema` return object.

### `buildColumnSchemas()` (manager.ts:563)

Thread `ColumnDef.tags` through to each `ColumnSchema`.

### `extractCheckConstraints()` (manager.ts:593)

Thread constraint-level tags from `ColumnConstraint.tags` and `TableConstraint.tags` to `RowConstraintSchema`.

### `extractForeignKeys()` (manager.ts:633)

Thread to `ForeignKeyConstraintSchema`.

### `extractUniqueConstraints()` (manager.ts:702)

Thread to `UniqueConstraintSchema`.

### `columnDefToSchema()` (table.ts:97)

Thread column-level tags.

### View and index creation paths

Thread tags from AST to `ViewSchema` and `IndexSchema` respectively.

## DDL Generation (catalog.ts:155)

`generateTableDDL()` should round-trip tags back to DDL so they survive schema reconstruction. Append `WITH TAGS (...)` to column definitions, constraints, and the table itself. Same for views and indexes in their respective generators.

## Schema Hashing

**No changes.** Tags are explicitly non-behavioral and must not affect schema hashes. The hasher (schema-hasher.ts) uses `generateDeclaredDDL()` — as long as that function does not emit tags, hashing is unaffected. If `generateDeclaredDDL` shares code with `generateTableDDL`, the tag emission must be gated or factored so the hash path excludes it.

## Programmatic API

Add a `SchemaManager` method to set/get tags on existing schema objects:

```typescript
setTableTags(tableName: string, tags: Record<string, SqlValue>, schemaName?: string): void
getTableTags(tableName: string, schemaName?: string): Readonly<Record<string, SqlValue>> | undefined
```

Similar for columns, constraints, etc. — but table-level is sufficient for the initial implementation. Column/constraint tag APIs can come later since they're less commonly needed programmatically.

## Tests

Add sqllogic tests covering:

- Table-level `WITH TAGS` on CREATE TABLE
- Column-level `WITH TAGS` on column definitions
- Constraint-level `WITH TAGS` on CHECK, UNIQUE, FOREIGN KEY
- `WITH TAGS` combined with `WITH CONTEXT` in any order
- Tag value types: string, number, boolean, null
- `TAGS` used as a regular identifier (ensure contextual keyword doesn't break)
- Tags surviving DDL round-trip (create table, read back from catalog)
- Tags not affecting schema hash (create two identical tables differing only in tags — same hash)
- View and index tags

## TODO

- Add `tags` field to all schema interfaces (TableSchema, ColumnSchema, RowConstraintSchema, ForeignKeyConstraintSchema, UniqueConstraintSchema, IndexSchema, ViewSchema)
- Add `tags` field to AST nodes (CreateTableStmt, ColumnDef, ColumnConstraint, TableConstraint, CreateViewStmt, CreateIndexStmt)
- Add `parseTags()` helper to parser
- Integrate tag parsing into `parseTrailingWithClauses()`, `columnConstraint()`, `columnDefinition()`, `tableConstraint()`, `createIndexStatement()`, `createViewStatement()`
- Thread tags through schema manager build methods
- Add tag emission to `generateTableDDL()` and related DDL generators (excluding hash paths)
- Add `setTableTags()`/`getTableTags()` to SchemaManager
- Add sqllogic test suite for metadata tags
- Verify build and all tests pass
