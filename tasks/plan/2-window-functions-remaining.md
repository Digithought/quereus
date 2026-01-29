---
description: Remaining window functions (LAG/LEAD, FIRST_VALUE/LAST_VALUE, RANGE BETWEEN, etc.)
dependencies: Window function infrastructure
priority: 2
---

## Architecture

*Details to be filled out during planning phase.*

Remaining window function implementations:
- LAG/LEAD: Offset access functions
- FIRST_VALUE/LAST_VALUE: Navigation functions
- RANGE BETWEEN: Range-based window frames
- PERCENT_RANK/CUME_DIST: Statistical ranking

**Principles:** SPP, DRY, modular architecture. Follow existing window function patterns.

## TODO

### Phase 1: Planning
- [ ] Review existing window function architecture
- [ ] Design each function's implementation

### Phase 2: Implementation
- [ ] Implement offset functions
- [ ] Implement navigation functions
- [ ] Implement range frames
- [ ] Implement statistical ranking

### Phase 3: Review & Test
- [ ] Review correctness
- [ ] Test against SQL standard

