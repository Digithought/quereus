---
description: Declarative schema remaining work (rename detection, imports, seeds, etc.)
dependencies: Declarative schema core, DDL engine

---

## Architecture

*Details to be filled out during planning phase.*

Enhancements to declarative schema:
- Rename detection with `old name` hints and stable `id` matching
- Destructive change gating with `allow_destructive`
- validate_only and dry_run modes
- Import support with cache and versioning
- Idempotent seeds with upsert logic
- Domain and collation declarations
- Helper TVFs: schema_diff(), schema_objects(), schema_hash()
- CLI integration, view/index DDL generation

DDL remains primary; declarative schema is optional overlay.

**Principles:** SPP, DRY, modular architecture. Safe by default.

## TODO

### Phase 1: Planning
- [ ] Prioritize enhancement order
- [ ] Design each feature

### Phase 2: Implementation
- [ ] Implement features incrementally

### Phase 3: Review & Test
- [ ] Review safety guarantees
- [ ] Test each feature

