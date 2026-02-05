---
description: Replace hash-based savepoint names with stack-based approach
dependencies: none
priority: 4
---

# Fix Savepoint Naming Collision Risk

## Problem

The current savepoint implementation uses a hash function to convert savepoint names to numeric indices:

```typescript
// runtime/emit/transaction.ts:11-19
function hashSavepointName(name: string): number {
	let hash = 0;
	for (let i = 0; i < name.length; i++) {
		const char = name.charCodeAt(i);
		hash = ((hash << 5) - hash) + char;
		hash = hash & hash;
	}
	return Math.abs(hash);
}
```

Different savepoint names can hash to the same index, causing incorrect rollback behavior. For example, `SAVEPOINT sp1` and `SAVEPOINT sp_collision` could map to the same index, and `ROLLBACK TO sp_collision` would incorrectly affect `sp1`'s state.

Additionally, there's no tracking of which savepoints have been created - `ROLLBACK TO` or `RELEASE` for a non-existent savepoint won't be caught.

## Solution

Replace hash-based indices with a stack-based approach using actual savepoint names or unique sequential IDs.

### Design

1. **TransactionManager tracks savepoint stack**: Maintain an ordered list of active savepoint names
2. **Validation on ROLLBACK TO / RELEASE**: Verify the savepoint exists before operating
3. **Proper unwinding**: ROLLBACK TO should pop all savepoints above the target

### Key Files

- `packages/quereus/src/runtime/emit/transaction.ts` - Savepoint emission
- `packages/quereus/src/core/database-transaction.ts` - TransactionManager
- `packages/quereus/src/core/database-events.ts` - Event layer management
- `packages/quereus/src/vtab/memory/layer/transaction.ts` - Memory table layers

## TODO

### Phase 1: TransactionManager Enhancement
- [ ] Add `savepointStack: string[]` to TransactionManager
- [ ] Add `createSavepoint(name: string)` that pushes to stack and returns depth index
- [ ] Add `findSavepoint(name: string)` that returns index or throws if not found
- [ ] Add `releaseSavepoint(name: string)` that validates and pops from target to top
- [ ] Add `rollbackToSavepoint(name: string)` that validates and returns layers to rollback

### Phase 2: Update Emission
- [ ] Remove `hashSavepointName()` function
- [ ] Update `emitSavepoint()` to use TransactionManager.createSavepoint()
- [ ] Update `emitReleaseSavepoint()` to use TransactionManager.releaseSavepoint()
- [ ] Update `emitRollbackToSavepoint()` to use TransactionManager.rollbackToSavepoint()
- [ ] Add proper error messages for invalid savepoint names

### Phase 3: Connection Interface
- [ ] Update VTableConnection.createSavepoint to accept name string
- [ ] Update VTableConnection.releaseSavepoint to accept name string
- [ ] Update VTableConnection.rollbackToSavepoint to accept name string
- [ ] Update memory table layer to track savepoint names

### Phase 4: Testing
- [ ] Add test for savepoint name uniqueness validation
- [ ] Add test for ROLLBACK TO non-existent savepoint (should error)
- [ ] Add test for RELEASE non-existent savepoint (should error)
- [ ] Add test for multiple savepoints with same prefix (ensure no collision)
- [ ] Add test for nested savepoints unwinding correctly
