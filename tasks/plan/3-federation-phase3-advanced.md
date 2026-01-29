---
description: Phase 3 Federation - Advanced predicate pushdown and projection/aggregation
dependencies: Federation phase 2, cost model
priority: 3
---

## Architecture

*Details to be filled out during planning phase.*

Advanced push-down optimization:
- OR-predicate factorization across children
- IN, BETWEEN, NULL test optimizations
- Subquery predicate pushdown with correlation
- Projection pushdown (only required attributes)
- Aggregation pushdown (COUNT, SUM, MIN, MAX)
- Range seeks with dynamic bounds
- IN-list strategy selection

**Principles:** SPP, DRY, modular architecture. Cost-based strategy selection.

## TODO

### Phase 1: Planning
- [ ] Design each optimization
- [ ] Plan cost integration

### Phase 2: Implementation
- [ ] Implement predicate optimizations
- [ ] Add projection pushdown
- [ ] Add aggregation pushdown
- [ ] Implement range seeks
- [ ] Add IN-list strategy

### Phase 3: Review & Test
- [ ] Review correctness
- [ ] Benchmark improvements

