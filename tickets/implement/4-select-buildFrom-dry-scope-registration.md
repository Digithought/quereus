description: Extract repeated scope registration pattern in buildFrom into a helper
dependencies: none
files:
  packages/quereus/src/planner/building/select.ts
----
## Design

The `buildFrom` function in `select.ts` (line 266) repeats the same 6-line scope-registration-plus-aliasing pattern 5 times for: internal recursive CTE (line 287), regular CTE (line 324), view (line 385), table (line 410), and function source (line 436).

### Helper function

Add a module-level helper in `select.ts`, near `buildFrom`:

```ts
/**
 * Registers each column of a relational node as a symbol in a new scope,
 * wrapped with an AliasedScope for qualified name resolution.
 */
function registerColumnScope(
  parentScope: Scope,
  node: RelationalPlanNode,
  scopeName: string,
  alias: string,
): Scope {
  const registered = new RegisteredScope(parentScope);
  const attributes = node.getAttributes();
  node.getType().columns.forEach((c, i) => {
    const attr = attributes[i];
    registered.registerSymbol(c.name.toLowerCase(), (exp, s) =>
      new ColumnReferenceNode(s, exp as AST.ColumnExpr, c.type, attr.id, i));
  });
  return new AliasedScope(registered, scopeName, alias);
}
```

Parameters:
- `parentScope`: the scope to parent the RegisteredScope to (always `parentContext.scope`)
- `node`: the `fromTable` node whose columns to register
- `scopeName`: first arg to AliasedScope (table/CTE name, or `''` for functions)
- `alias`: second arg to AliasedScope (effective alias, defaulted by caller when no explicit alias)

### Call sites

Each of the 5 repetitions becomes a single call. The caller computes the effective alias:

1. **Internal recursive CTE** (line ~287-299):
   `columnScope = registerColumnScope(parentContext.scope, fromTable, tableName, fromClause.alias?.toLowerCase() ?? tableName);`

2. **Regular CTE** (line ~324-338):
   `columnScope = registerColumnScope(parentContext.scope, fromTable, tableName, fromClause.alias?.toLowerCase() ?? tableName);`

3. **View** (line ~385-397):
   `columnScope = registerColumnScope(parentContext.scope, fromTable, fromClause.table.name.toLowerCase(), fromClause.alias?.toLowerCase() ?? fromClause.table.name.toLowerCase());`

4. **Table** (line ~410-422):
   `columnScope = registerColumnScope(parentContext.scope, fromTable, fromClause.table.name.toLowerCase(), fromClause.alias?.toLowerCase() ?? fromClause.table.name.toLowerCase());`

5. **Function source** (line ~436-449):
   `columnScope = registerColumnScope(parentContext.scope, fromTable, '', fromClause.alias?.toLowerCase() ?? fromClause.name.name.toLowerCase());`

### Not in scope

The subquery (line 473) and mutating subquery (line 519) cases have meaningfully different logic (custom column names, bounds checking, type fallback, conditional AliasedScope wrapping) and should remain inline.

### Testing

This is a pure refactoring — no behavioral change. All existing tests exercising FROM clauses (tables, views, CTEs, joins, table functions) validate correctness. Run:
- `yarn build` (type check)
- `yarn test` (full suite)

Key test files covering FROM clause behavior:
- `packages/quereus/test/logic/*.sqllogic` (SQL logic tests)
- `packages/quereus/test/planner/` (planner-specific tests)
- `packages/quereus/test/vtab/` (virtual table tests)

## TODO

- Add `registerColumnScope` helper function above `buildFrom` in `select.ts`
- Replace internal recursive CTE scope registration (lines ~287-299) with helper call
- Replace regular CTE scope registration (lines ~324-338) with helper call
- Replace view scope registration (lines ~385-397) with helper call
- Replace table scope registration (lines ~410-422) with helper call
- Replace function source scope registration (lines ~436-449) with helper call
- Run `yarn build` — must pass
- Run `yarn test` — must pass
