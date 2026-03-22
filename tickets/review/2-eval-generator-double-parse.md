description: Eliminated redundant SQL re-parse in Database._evalGenerator
dependencies: none
files:
  packages/quereus/src/core/database.ts
----
## Summary

Removed the redundant `this._parseSql(sql)` call in `Database._evalGenerator()`. When handling multi-statement batches, the method was parsing SQL twice: once via `this.prepare(sql)` (which stores the AST in `stmt.astBatch`) and again via `this._parseSql(sql)`. The fix replaces the second parse with direct use of `stmt.astBatch`.

## Change

In `_evalGenerator()` (~line 1214), replaced:
```typescript
const batch = this._parseSql(sql);
// ... batch[i] / batch[batch.length - 1]
```
with:
```typescript
// ... stmt.astBatch[i] / stmt.astBatch[stmt.astBatch.length - 1]
```

## Testing / Validation

- All 10 multi-statement tests pass (`test/multi-statement.spec.ts`), covering:
  - `exec()` multi-statement batches (CREATE+INSERT, multiple UPDATEs, CREATE+INSERT combo)
  - `eval()` multi-statement batches (setup+query, multiple INSERTs+SELECT, single statement)
  - Transaction semantics: commit on break, commit on return(), rollback on throw(), sequential partial consumptions
- Build passes with no type errors
- Full test suite passes (one pre-existing unrelated failure in `emit-missing-types.spec.ts`)
