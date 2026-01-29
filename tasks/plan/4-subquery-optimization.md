---
description: Transform correlated subqueries to joins for better performance
dependencies: Titan optimizer, join infrastructure
priority: 4
---

## Architecture

*Details to be filled out during planning phase.*

Subquery decorrelation transforms correlated scalar and EXISTS subqueries into equivalent joins. Enables join enumeration to consider these expressions in cost-based optimization.

**Principles:** SPP, DRY, modular architecture. Leverage existing join planning infrastructure.

## TODO

### Phase 1: Planning
- [ ] Analyze subquery patterns and correlation types
- [ ] Design transformation rules

### Phase 2: Implementation
- [ ] Implement subquery-to-join transformations

### Phase 3: Review & Test
- [ ] Review transformation correctness
- [ ] Test various subquery patterns

