---
description: Hash joins and merge joins for improved join performance
dependencies: Titan optimizer, runtime emit infrastructure
---

## Architecture

Alternative join algorithms beyond nested loop. Bloom join for equality predicates on large sparse datasets. Merge join for sorted inputs.  Materialize sorted index for large dense datasets. Optimizer selects based on input characteristics and cost.

**Benchmark baseline (performance sentinel test):** A self-join of 50 rows against 1000 rows (nested-loop, `perf_t a join perf_t b on a.val = b.val where a.id <= 50`) takes ~3500–4200 ms. A bloom join should bring this to ~100 ms or less.

**Principles:** SPP, DRY, modular architecture. Join algorithms should be pluggable.

## TODO

### Phase 1: Planning
- [ ] Analyze join algorithm applicability criteria
- [ ] Design algorithm selection in optimizer
- [ ] Consider dynamically detecting and switching at runtime too

### Phase 2: Implementation
- [ ] Implement bloom join operator
- [ ] Implement merge join operator
- [ ] Implement materialize sorted index operator

### Phase 3: Review & Test
- [ ] Review algorithm correctness
- [ ] Benchmark join performance

