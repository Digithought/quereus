description: Support OR conditions in constraint extraction and predicate pushdown
dependencies: constraint-extractor, predicate-pushdown rules, BestAccessPlan API

The constraint extractor currently handles binary predicates (=, <, >, <=, >=), IN lists, IS NULL/IS NOT NULL, and BETWEEN. OR conditions and complex compound expressions are not yet supported and fall through as residual filters.

OR predicates appear frequently in real queries (`WHERE status = 'active' OR status = 'pending'`) and can often be translated into index-friendly forms (e.g., multi-seek or UNION of seeks).

### Scope

- Extend the constraint extractor to recognize OR-of-equality on the same column and collapse to IN lists (partially handled for small cases already via normalization)
- Support OR conditions where each branch constrains the same index columns, translating to multiple index seeks or range scans
- Evaluate cost of OR-to-UNION rewriting for disjoint index-friendly branches vs. residual filter
- Ensure correctness: OR branches that reference different tables or non-indexable expressions remain as residual filters

### References

- `src/planner/analysis/constraint-extractor.ts` - core extraction logic
- `src/planner/analysis/normalize.ts` - predicate normalization (already collapses small OR-of-equality to IN)
- `docs/optimizer.md` Known Issues section
