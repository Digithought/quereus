---
description: Key-driven row-count reduction with FK→PK inference and optimizer exploitation
dependencies: Key inference system, optimizer cost model

---

## Architecture

*Details to be filled out during planning phase.*

Better key inference enables improved cardinality estimation. FK→PK join inference derives keys when ON clause aligns PK with inferred unique set. Optimizer uses preserved keys for pruning and join strategy selection.

**Principles:** SPP, DRY, modular architecture. Key propagation should be systematic.

## TODO

### Phase 1: Planning
- [ ] Analyze key inference patterns
- [ ] Design FK→PK recognition

### Phase 2: Implementation
- [ ] Implement key inference improvements
- [ ] Add optimizer exploitation rules

### Phase 3: Review & Test
- [ ] Review inference correctness
- [ ] Test cardinality improvements

