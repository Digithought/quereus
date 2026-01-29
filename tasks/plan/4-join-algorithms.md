---
description: Hash joins and merge joins for improved join performance
dependencies: Titan optimizer, runtime emit infrastructure
priority: 4
---

## Architecture

*Details to be filled out during planning phase.*

Alternative join algorithms beyond nested loop. Hash join for equality predicates on large datasets. Merge join for sorted inputs. Optimizer selects based on input characteristics and cost.

**Principles:** SPP, DRY, modular architecture. Join algorithms should be pluggable.

## TODO

### Phase 1: Planning
- [ ] Analyze join algorithm applicability criteria
- [ ] Design algorithm selection in optimizer

### Phase 2: Implementation
- [ ] Implement hash join operator
- [ ] Implement merge join operator

### Phase 3: Review & Test
- [ ] Review algorithm correctness
- [ ] Benchmark join performance

