---
description: Push aggregations below joins when semantically valid
dependencies: Titan optimizer, aggregation planning

---

## Architecture

*Details to be filled out during planning phase.*

Aggregate pushdown optimization moves GROUP BY and aggregate functions closer to data sources when semantic equivalence is preserved. Reduces intermediate result sizes.

**Principles:** SPP, DRY, modular architecture. Validate semantic equivalence carefully.

## TODO

### Phase 1: Planning
- [ ] Define semantic validity conditions
- [ ] Design pushdown rules

### Phase 2: Implementation
- [ ] Implement aggregate pushdown transformations

### Phase 3: Review & Test
- [ ] Review semantic correctness
- [ ] Test edge cases

