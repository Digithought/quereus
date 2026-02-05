---
description: Extract repeated transaction finalization pattern into helper
dependencies: none
priority: 3
---

# DRY: Transaction Finalization Pattern

## Problem

The same transaction finalization pattern is repeated 5+ times across the codebase:

```typescript
if (this.db._isImplicitTransaction()) {
	if (success) {
		await this.db._commitTransaction();
	} else {
		await this.db._rollbackTransaction();
	}
}
```

**Occurrences:**
- `statement.ts:326-334` - `iterateRows()`
- `statement.ts:405-413` - `run()`
- `statement.ts:436-443` - `get()`
- `statement.ts:466-473` - `all()`
- `database.ts:1171-1177` - `_evalGenerator()`

## Solution

Extract to a helper method on Database class.

### Design

```typescript
// In Database class
async finalizeImplicitTransaction(success: boolean): Promise<void> {
	if (this.transactionManager.isImplicitTransaction()) {
		if (success) {
			await this._commitTransaction();
		} else {
			await this._rollbackTransaction();
		}
	}
}
```

Or as a utility function:
```typescript
async function finalizeImplicitTransaction(db: Database, success: boolean): Promise<void>
```

### Key Files

- `packages/quereus/src/core/database.ts`
- `packages/quereus/src/core/statement.ts`

## TODO

- [ ] Add `finalizeImplicitTransaction(success: boolean)` method to Database class
- [ ] Replace pattern in `Statement.iterateRows()` with method call
- [ ] Replace pattern in `Statement.run()` with method call
- [ ] Replace pattern in `Statement.get()` with method call
- [ ] Replace pattern in `Statement.all()` with method call
- [ ] Replace pattern in `Database._evalGenerator()` with method call
- [ ] Verify all tests still pass
