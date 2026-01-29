---
description: Constraints requiring access to before AND after transaction state
dependencies: Constraint system, transaction infrastructure
priority: 4
---

## Architecture

*Details to be filled out during planning phase.*

New constraint class enabling validation that requires both pre-transaction and post-transaction state. For example, asserting a row was removed. Pre-query captures state before changes, result available to post-constraint logic.

**Principles:** SPP, DRY, modular architecture. Clean separation of before/after phases.

## TODO

### Phase 1: Planning
- [ ] Design before/after constraint semantics
- [ ] Define pre-query and post-constraint interface

### Phase 2: Implementation
- [ ] Implement before-state capture
- [ ] Implement constraint evaluation

### Phase 3: Review & Test
- [ ] Review transaction interaction
- [ ] Test constraint scenarios

