---
description: Add event system, instruction tracing, and database options sections to docs/usage.md
dependencies: docs/usage.md, docs/module-authoring.md, packages/quereus/src/core/database.ts, packages/quereus/src/core/database-options.ts, packages/quereus/src/core/database-events.ts
files:
  - docs/usage.md
  - packages/quereus/src/core/database.ts
  - packages/quereus/src/core/database-options.ts
  - packages/quereus/src/core/database-events.ts
  - packages/quereus/src/runtime/explain.ts
---

## Architecture

`docs/usage.md` is the primary consumer-facing guide but is missing three important sections: the event system, instruction tracing, and database options/pragmas. Add these sections to make usage.md a complete reference for application developers.

### Content to Add

**Event System Section** — Add after the Transactions section (before "Database API Reference"):
- `db.onDataChange(listener)` — subscribe to data change events, returns unsubscribe function
- `db.onSchemaChange(listener)` — subscribe to schema change events, returns unsubscribe function
- `DatabaseDataChangeEvent` interface: `type` ('insert'|'update'|'delete'), `schemaName`, `tableName`, `key`, `oldRow`, `newRow`, `remote`
- `DatabaseSchemaChangeEvent` interface: `type` ('table_added'|'table_removed'|etc.), `schemaName`, `objectName`
- Events are batched within transactions and delivered after successful commit
- Code example showing subscription pattern and event handling
- Cross-reference to module-authoring.md for module-level event integration details
- Source: `packages/quereus/src/core/database-events.ts`, module-authoring.md lines 606-788

**Database Options/Pragmas Section** — Add after the event system section:
- `db.setOption(key, value)` and `db.getOption(key)` — programmatic access
- SQL equivalent: `pragma key = value` / `pragma key`
- Key options:
  - `schema_path` — schema search path (comma-separated)
  - `default_column_nullability` — 'not_null' (default, Third Manifesto) or 'nullable'
  - `default_vtab_module` / `default_vtab_args` — default virtual table module
- Type-safe getters: `getBooleanOption()`, `getStringOption()`, `getObjectOption()`
- Source: `packages/quereus/src/core/database-options.ts`

**Instruction Tracing Section** — Add to the Database API Reference:
- Expand the existing one-liner for `db.setInstructionTracer()` into a subsection
- `InstructionTracer` interface description
- Debug table-valued functions: `query_plan(sql)`, `scheduler_program(sql)`, `execution_trace(sql)`, `stack_trace(sql)`, `row_trace(sql)`
- Code example showing how to use debug TVFs for query analysis
- Cross-reference to functions.md for full debug function details
- Source: `packages/quereus/src/runtime/explain.ts`, functions.md lines 490-506

## TODO

- [ ] Add "Event System" section to usage.md (after Transactions, before Database API Reference)
  - [ ] Document `db.onDataChange()` and `db.onSchemaChange()` with examples
  - [ ] Show DatabaseDataChangeEvent and DatabaseSchemaChangeEvent shapes
  - [ ] Note transaction batching semantics
  - [ ] Cross-reference module-authoring.md for module integration
- [ ] Add "Database Options" section to usage.md
  - [ ] Document `setOption`/`getOption` with pragmas equivalence
  - [ ] List key options with descriptions
- [ ] Expand instruction tracing in Database API Reference
  - [ ] Document debug TVFs with examples
  - [ ] Cross-reference functions.md
