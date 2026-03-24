description: Extract repeated scope registration pattern in buildFrom into a helper
dependencies: none
files:
  packages/quereus/src/planner/building/select.ts
----
## Finding: DRY violation in `buildFrom`

**Severity**: smell

The `buildFrom` function in `select.ts` repeats the same scope-registration pattern 5 times (CTE internal recursive, CTE regular, view, table, function source). Each repetition:

1. Creates a `RegisteredScope(parentContext.scope)`
2. Gets attributes via `node.getAttributes()`
3. Iterates `node.getType().columns.forEach(...)` to register symbols with `ColumnReferenceNode` factories
4. Wraps in `AliasedScope` with alias/tableName handling

This pattern could be extracted into a helper like:

```ts
function createColumnScope(
  parentScope: Scope,
  node: RelationalPlanNode,
  tableName: string,
  alias?: string
): Scope
```

This would reduce the function's size significantly and eliminate the risk of inconsistency between the 5 copies (e.g., one of the copies might forget to lowercase a name).

**Why it matters**: The function is ~280 lines and the repetition makes it hard to verify correctness across all FROM clause types. A single helper ensures consistent behavior.
