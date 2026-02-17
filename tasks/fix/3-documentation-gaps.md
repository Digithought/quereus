---
description: Fill documentation gaps identified during review
dependencies: docs/, packages/quereus/src/
priority: 3
---

## Architecture

Documentation improvements to fill coverage gaps found during the documentation review. These are missing or incomplete sections in existing docs files — no new doc files should be created per AGENTS.md conventions.

## TODO

### High Priority

- [ ] Expand `docs/errors.md` — currently 56 lines; missing: full error class hierarchy, status code table, error chain examples, common error patterns
- [ ] Complete `docs/schema.md` — missing: `defineTable()`, `getSchemaPath()`, `setOption()`/`getOption()`, `DeclaredSchemaManager` API, `DECLARE SCHEMA`/`DIFF SCHEMA`/`APPLY SCHEMA` syntax
- [ ] Document event system in `docs/usage.md` or `docs/module-authoring.md` — `onDataChange()`, `onSchemaChange()`, `DatabaseDataChangeEvent`, `DatabaseSchemaChangeEvent` are under-documented

### Medium Priority

- [ ] Document database options/pragmas in `docs/usage.md` — `setOption()`, `getOption()`, `schema_path`, `default_column_nullability`
- [ ] Document instruction tracing in `docs/usage.md` — `getInstructionTracer()`, `prepareDebug()`, `query_plan()`, `scheduler_program()`, `execution_trace()`
- [ ] Add cross-references between docs — types.md↔functions.md, usage.md↔schema.md, plugins.md↔functions.md
- [ ] Reduce DRY violations — transaction management is documented in README, usage.md, and runtime.md; consolidate to usage.md with cross-references

### Low Priority

- [ ] Document collation registration system — `registerCollation()`, `getCollation()`, custom collation authoring
- [ ] Document custom type registration — `registerType()`, `getType()`, `inferType()`
- [ ] Standardize terminology — "virtual table module" vs "module" vs "VTab module"; "connection" vs "VirtualTableConnection"
- [ ] Improve JSDoc coverage on `index.ts` re-exports (currently 0%)

