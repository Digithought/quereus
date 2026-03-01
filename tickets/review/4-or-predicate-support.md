description: OR conditions in constraint extraction and predicate pushdown
dependencies: constraint-extractor, predicate-normalizer, rule-select-access-path

## Summary

Added OR predicate support to the constraint extractor, enabling OR-of-equality disjunctions to be extracted as IN constraints and pushed down to indexes for multi-seek execution.

### What was built

**Constraint extractor OR analysis** (`constraint-extractor.ts`):
- `flattenOrDisjuncts()`: flattens OR expression trees into disjunct lists
- `tryExtractOrBranches()`: analyzes OR branches, extracts per-branch constraints
- `collapseBranchesToIn()`: merges equality and IN branches on same column into combined IN constraint
- Handles mixed equality + IN branches (from nested OR normalization where inner ORs collapse to IN first)
- Correctness: OR branches referencing different tables, different columns, or with non-extractable sub-expressions remain as residual filters

**Non-literal IN support** (`constraint-extractor.ts`):
- Extended `extractInConstraint` to accept parameter/expression values alongside literals
- Sets `valueExpr` and `bindingKind: 'mixed'` for non-literal IN lists

**Access path selection** (`rule-select-access-path.ts`):
- Updated multi-seek code to use `valueExpr` array when available (mixed-binding IN from OR collapse)

**Documentation** (`docs/optimizer.md`):
- Updated Known Issues to reflect OR-of-equality support
- Added Future Directions notes for OR-to-UNION rewriting and OR multi-range seek

### Key files

- `packages/quereus/src/planner/analysis/constraint-extractor.ts` — core OR extraction logic
- `packages/quereus/src/planner/rules/access/rule-select-access-path.ts` — mixed-binding IN seek keys
- `packages/quereus/test/optimizer/predicate-analysis.spec.ts` — unit tests for OR extraction
- `packages/quereus/test/optimizer/extended-constraint-pushdown.spec.ts` — integration + plan tests
- `docs/optimizer.md` — updated documentation

### Testing

**Unit tests** (predicate-analysis.spec.ts):
- OR of equalities on same column → IN constraint
- Three-way OR of equalities → IN
- OR on different columns → residual
- OR with non-extractable branch → residual
- OR with range predicates → residual (Phase 2 future)
- OR combined with AND → both constraints extracted

**Integration tests** (extended-constraint-pushdown.spec.ts):
- OR of equalities on PK → correct rows
- Three-way OR on PK → correct rows
- OR on non-PK column → correct rows
- OR on different columns (residual) → correct rows
- OR combined with AND → correct rows
- OR with range predicates → correct rows

**Plan verification tests**:
- OR of equalities on PK → IndexSeek (not SeqScan)
- Three-way OR on PK → IndexSeek
- OR on different columns → no IndexSeek (residual filter)

**Full suite**: 751 passing, 3 pending (pre-existing)

### What's deferred

- **OR multi-range seek**: `col > 10 OR col < -10` on same index → multiple range scans. Requires extending ScanPlan and cursor layers. Documented in optimizer.md Future Directions.
- **OR-to-UNION rewriting**: `colA = 1 OR colB = 2` with separate indexes → UNION ALL of per-branch queries. Requires UnionAllNode insertion and cost model. Documented in optimizer.md Future Directions.
