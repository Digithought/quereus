---
description: Hash joins and merge joins for improved join performance
dependencies: Titan optimizer, runtime emit infrastructure
priority: 4
---

## Architecture

Alternative join algorithms beyond nested loop. Hash join for equality predicates on large datasets. Merge join for sorted inputs. Optimizer selects based on input characteristics and cost.

**Benchmark baseline (performance sentinel test):** A self-join of 50 rows against 1000 rows (nested-loop, `perf_t a join perf_t b on a.val = b.val where a.id <= 50`) takes ~3500–4200 ms. A hash join should bring this to ~100 ms or less.

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

