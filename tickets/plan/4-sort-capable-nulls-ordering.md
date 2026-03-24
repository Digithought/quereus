description: SortCapable interface loses nulls ordering information
dependencies: none
files:
  packages/quereus/src/planner/nodes/sort.ts
  packages/quereus/src/planner/framework/characteristics.ts
----
The `SortCapable` interface in `characteristics.ts` defines sort keys as `{ expression, direction }` without a `nulls` field. When `SortNode.withSortKeys()` creates new sort keys from this interface, it sets `nulls: undefined`, losing any explicit NULLS FIRST/NULLS LAST ordering.

This means optimizer rules that rewrite sort keys through the `SortCapable` interface will silently discard null ordering semantics.

**Fix**: Extend the `SortCapable` interface to include optional `nulls?: 'first' | 'last'` in its sort key type, and update `SortNode.withSortKeys()` to preserve it.

- [ ] Add `nulls?: 'first' | 'last'` to SortCapable's sort key type
- [ ] Update SortNode.withSortKeys to preserve the nulls field
- [ ] Audit callers of withSortKeys to ensure they pass through nulls when available
