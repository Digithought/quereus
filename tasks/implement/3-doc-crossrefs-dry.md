---
description: Add cross-references between docs and reduce DRY violations
dependencies: docs/usage.md, docs/types.md, docs/functions.md, docs/schema.md, docs/plugins.md, docs/errors.md, docs/runtime.md, packages/quereus/README.md
files:
  - docs/usage.md
  - docs/types.md
  - docs/functions.md
  - docs/schema.md
  - docs/plugins.md
  - docs/errors.md
  - docs/runtime.md
  - packages/quereus/README.md
---

## Architecture

Add cross-references between documentation files so readers can discover related content, and consolidate duplicated content (especially transaction management) to reduce DRY violations.

### Cross-References to Add

**types.md ↔ functions.md:**
- types.md: link to functions.md for type conversion functions (date(), time(), datetime(), json(), cast())
- functions.md: link to types.md for the full type system reference

**usage.md ↔ schema.md:**
- usage.md declarative schema section: link to schema.md for DeclaredSchemaManager API
- schema.md: link to usage.md for the consumer-facing declarative schema workflow

**plugins.md ↔ functions.md:**
- plugins.md: link to functions.md for function registration API details
- functions.md: link to plugins.md for plugin-based function registration

**errors.md ↔ usage.md:**
- usage.md error handling section: link to errors.md for the full error reference
- errors.md: link to usage.md for practical error handling patterns

**types.md ↔ plugins.md:**
- types.md custom types section: link to plugins.md for plugin-based type registration
- plugins.md: link to types.md for LogicalType interface and collation details

### DRY Consolidation: Transaction Management

Transaction management is documented in three places:
1. **usage.md** (lines 171-253) — comprehensive with implicit/explicit transactions, savepoints, examples
2. **runtime.md** (line 830) — brief architectural mention
3. **README.md** (lines ~138-142) — brief overview with example

**Action:** usage.md has the canonical, comprehensive content. In runtime.md and README.md, replace inline transaction details with cross-references to usage.md. Keep brief contextual mentions but avoid duplicating the how-to content.

### Low-Priority Items (include if straightforward)

- Standardize "virtual table module" vs "module" vs "VTab module" terminology — prefer "virtual table module" on first mention, "module" thereafter
- Note about accessing SchemaManager/DeclaredSchemaManager via `db.schemaManager`/`db.declaredSchemaManager` in usage.md

## TODO

- [ ] Add cross-reference links between types.md ↔ functions.md
- [ ] Add cross-reference links between usage.md ↔ schema.md
- [ ] Add cross-reference links between plugins.md ↔ functions.md
- [ ] Add cross-reference links between errors.md ↔ usage.md
- [ ] Add cross-reference links between types.md ↔ plugins.md
- [ ] Consolidate transaction docs: replace duplicated content in runtime.md and README.md with cross-references to usage.md
