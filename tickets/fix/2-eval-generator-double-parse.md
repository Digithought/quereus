description: Database._evalGenerator parses SQL twice for multi-statement batches
dependencies: none
files:
  packages/quereus/src/core/database.ts
----
In `Database._evalGenerator()`, when the SQL contains multiple statements:

1. `stmt = this.prepare(sql)` parses the SQL into `stmt.astBatch`
2. Then `const batch = this._parseSql(sql)` parses the **same SQL again**

The second parse is redundant. `stmt.astBatch` already contains the parsed AST and should be used directly instead. The double parse wastes CPU and introduces a theoretical correctness risk if parser behavior were ever non-deterministic.

Fix: replace `this._parseSql(sql)` with `stmt.astBatch`:

```typescript
if (stmt.astBatch.length > 1) {
    for (let i = 0; i < stmt.astBatch.length - 1; i++) {
        await this._executeSingleStatement(stmt.astBatch[i], params);
    }
    const lastStmt = new Statement(this, [stmt.astBatch[stmt.astBatch.length - 1]]);
    ...
}
```

- TODO: Use stmt.astBatch instead of re-parsing in _evalGenerator
- TODO: Verify multi-statement eval tests still pass
