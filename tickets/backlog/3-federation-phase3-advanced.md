---
description: Phase 3 Federation - Advanced predicate pushdown and projection/aggregation
prereq: Federation phase 2, cost model

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

