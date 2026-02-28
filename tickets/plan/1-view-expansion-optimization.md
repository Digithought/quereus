description: Optimize view expansions to avoid redundant computation and enable cross-view optimization
dependencies: view system, optimizer framework

When views are expanded inline, the resulting plan may contain redundant subexpressions or miss optimization opportunities that would be visible at the view boundary level. This task covers optimizations specific to view expansion.

### Scope

- Predicate pushdown through view boundaries into the view's underlying query
- Projection pruning: eliminate columns from the view expansion that are not referenced by the outer query
- Merge adjacent filter/project nodes that arise from view expansion layering
- Consider view merging: flatten simple views (single-table SELECT with WHERE) directly into the outer query plan

### References

- `docs/optimizer.md` Future Directions section
