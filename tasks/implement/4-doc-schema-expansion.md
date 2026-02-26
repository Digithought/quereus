---
description: Expand docs/schema.md with missing API documentation
dependencies: docs/schema.md, packages/quereus/src/core/database.ts, packages/quereus/src/schema/declared-schema-manager.ts, packages/quereus/src/core/database-options.ts
files:
  - docs/schema.md
  - packages/quereus/src/core/database.ts
  - packages/quereus/src/schema/declared-schema-manager.ts
  - packages/quereus/src/core/database-options.ts
---

## Architecture

`docs/schema.md` covers SchemaManager well but is missing several related APIs. Add documentation for `defineTable()`, `getSchemaPath()`, `DeclaredSchemaManager`, and expand the declarative schema section.

### Content to Add

**`defineTable()` method** — Add to the DDL Operations section:
- Signature: `defineTable(definition: TableSchema): void`
- Purpose: Programmatic alternative to `CREATE TABLE` — registers a TableSchema directly in the `main` schema
- Currently only supports `main` schema (throws MisuseError otherwise)
- Use case: when you have a TableSchema object from parsing or programmatic construction
- Source: `packages/quereus/src/core/database.ts` lines ~797-804

**`getSchemaPath()` method** — Add to SchemaManager API or a new "Schema Path" section:
- Signature: `getSchemaPath(): string[]`
- Returns array of schema names in search order
- Complements the already-documented `setSchemaPath()`
- Source: `packages/quereus/src/core/database.ts` lines ~983-986

**`DeclaredSchemaManager` API** — Expand the "Declarative Schema" section:
- `setDeclaredSchema(schemaName, declaration)` — stores a DECLARE SCHEMA AST
- `getDeclaredSchema(schemaName)` — retrieves stored declaration
- `hasDeclaredSchema(schemaName)` — check if declaration exists
- `setSeedData(schemaName, tableName, rows)` — store seed data
- `getSeedData(schemaName, tableName)` — retrieve seed data
- `getAllSeedData(schemaName)` — get all seed data for a schema
- `clearSeedData(schemaName)` — clear seed data
- `removeDeclaredSchema(schemaName)` — remove declaration entirely
- Source: `packages/quereus/src/schema/declared-schema-manager.ts`

**Declarative Schema SQL semantics** — Expand existing section:
- Migration order: drops first, creates second, alters third
- Forward references between tables (foreign keys to later-declared tables are fine)
- Seed data semantics: clears table before inserting
- Schema hashing for versioning (`explain schema` returns hash)
- Cross-reference to sql.md for full syntax

**`setOption()`/`getOption()` cross-reference** — Brief mention with pointer to usage.md:
- These are Database-level methods, not SchemaManager methods
- Options like `schema_path` and `default_column_nullability` affect schema behavior
- Point to usage.md for the full options/pragmas reference

## TODO

- [ ] Add `defineTable()` to DDL Operations section
- [ ] Add `getSchemaPath()` alongside existing schema path docs (or verify it's already there)
- [ ] Add "DeclaredSchemaManager API" subsection under Declarative Schema with method table
- [ ] Expand declarative schema semantics (migration order, forward refs, seed data, hashing)
- [ ] Add brief cross-reference to database options that affect schema behavior
