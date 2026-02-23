---
description: Enforce NOT NULL, CHECK, and DEFAULT constraints in MemoryTable DML operations
dependencies: none
---

## Problem

The MemoryTable currently only enforces PRIMARY KEY UNIQUE constraints. Other constraints are parsed and stored in the schema but not enforced during DML:

1. **NOT NULL** — INSERT/UPDATE of NULL into a NOT NULL column silently succeeds
2. **CHECK** — CHECK constraint expressions are parsed but never evaluated during mutations
3. **DEFAULT** — DEFAULT clauses are not applied when columns are omitted in INSERT

These are documented in `docs/memory-table.md` under "Current Limitations".

## TODO

### Phase 1: Planning
- [ ] Identify where constraint checks should be injected (mutation path in layer cursors vs planner-emitted validation)
- [ ] Design DEFAULT value resolution (compile default expressions once, evaluate per-row)
- [ ] Determine error messages and SQLSTATE codes for constraint violations

### Phase 2: Implementation
- [ ] Enforce NOT NULL during INSERT and UPDATE in MemoryTable mutation path
- [ ] Evaluate CHECK constraint expressions during INSERT and UPDATE
- [ ] Apply DEFAULT values for omitted columns during INSERT
- [ ] Ensure constraint enforcement respects transaction rollback (no partial side effects)

### Phase 3: Review & Test
- [ ] Add tests for NOT NULL violation on INSERT and UPDATE
- [ ] Add tests for CHECK constraint evaluation
- [ ] Add tests for DEFAULT value application (literals, expressions, NULL default)
- [ ] Update `docs/memory-table.md` limitations section
