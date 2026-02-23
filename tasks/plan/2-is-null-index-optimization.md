---
description: Index-level IS NULL / IS NOT NULL optimization instead of residual filters
dependencies: 4-vtab-extended-constraint-pushdown (complete)
---

## Problem

IS NULL and IS NOT NULL predicates are currently handled as residual filters after a full scan or index scan. The constraint extractor only handles binary expressions; IS NULL/IS NOT NULL are unary expressions and never reach `getBestAccessPlan` as `PredicateConstraint` entries.

Documented in `docs/memory-table.md` under "Current Limitations" and noted in `tasks/complete/4-vtab-extended-constraint-pushdown.md` as future work.

## TODO

### Phase 1: Planning
- [ ] Design unary constraint extraction in the constraint extractor
- [ ] Design proper empty-result physical node for impossible predicates (e.g., IS NULL on NOT NULL column)
- [ ] Determine how index-level NULL-aware scanning works with inherited BTrees

### Phase 2: Implementation
- [ ] Extract IS NULL / IS NOT NULL as constraints in constraint extractor
- [ ] Add empty-result plan/node type for provably impossible predicates
- [ ] Wire IS NULL/IS NOT NULL into `findEqualityMatches` or a separate null-aware path
- [ ] Update cost model for NULL-aware access

### Phase 3: Review & Test
- [ ] Test IS NULL on indexed nullable column uses index
- [ ] Test IS NULL on NOT NULL column returns empty without scan
- [ ] Test IS NOT NULL on nullable column
- [ ] Update `docs/memory-table.md` limitations section
