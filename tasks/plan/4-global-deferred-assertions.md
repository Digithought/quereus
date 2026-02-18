---
description: Database-wide integrity assertions deferrable at COMMIT
dependencies: Schema system, transaction infrastructure, optimizer

---

## Architecture

*Details to be filled out during planning phase.*

IntegrityConstraint schema objects with violation queries. Classification of row-specific vs global assertions. Parameterized assertion plans for efficient checking. Commit-time evaluation engine with early-fail.

See docs/design-isolation-layer.md for isolation context.

**Principles:** SPP, DRY, modular architecture. Efficient delta-based checking where possible.

## TODO

### Phase 1: Planning
- [ ] Design IntegrityConstraint schema object
- [ ] Plan dependency discovery and classification

### Phase 2: Implementation
- [ ] Implement SQL surface and schema objects
- [ ] Add dependency tracking
- [ ] Implement optimizer classification
- [ ] Build parameterized plan infrastructure
- [ ] Create commit-time evaluation engine
- [ ] Add diagnostics (explain_assertion)

### Phase 3: Review & Test
- [ ] Review design correctness
- [ ] Test parser/DDL round-trip
- [ ] Test classification correctness
- [ ] Test commit-time enforcement

