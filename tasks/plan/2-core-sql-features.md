---
description: Core SQL feature enhancements (DELETE FROM, orthogonal expressions, etc.)
dependencies: Parser, planner, runtime

---

## Architecture

*Details to be filled out during planning phase.*

SQL feature enhancements:
- DELETE T FROM ...: Target alias specification for DML
- Orthogonal relational expressions in relational contexts
- VALUES in select locations (views)
- Expression-based functions
- Scheduler run method determination at constructor time

**Principles:** SPP, DRY, modular architecture. Maintain SQL standard compatibility.

## TODO

### Phase 1: Planning
- [ ] Design each feature's semantics
- [ ] Identify parser/planner changes

### Phase 2: Implementation
- [ ] Implement features incrementally

### Phase 3: Review & Test
- [ ] Review for standards compliance
- [ ] Test each feature

