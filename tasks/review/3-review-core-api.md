---
description: Completed review of core API (Database, Statement, Events, Transactions)
dependencies: none
priority: 3
---

# Core API Review - Findings & Recommendations

This document summarizes the comprehensive review of the Quereus core API including Database, Statement, Events, and Transaction support.

## 1. Architecture Summary

The core API is well-structured with clear separation of concerns:

- **Database** (`database.ts`) - Main entry point, coordinates schema, statements, transactions, and events
- **Statement** (`statement.ts`) - Prepared statement wrapper with binding, execution, and iteration
- **TransactionManager** (`database-transaction.ts`) - Transaction lifecycle, savepoints, change tracking
- **DatabaseEventEmitter** (`database-events.ts`) - Batched event aggregation from modules
- **DeferredConstraintQueue** (`deferred-constraint-queue.ts`) - Deferred constraint evaluation

### Public API Surface

**Database:**
- Query: `prepare()`, `exec()`, `get()`, `eval()`, `getPlan()`
- Transaction: `beginTransaction()`, `commit()`, `rollback()`
- Schema: `defineTable()`, `registerModule()`, `setSchemaPath()`
- Functions: `createScalarFunction()`, `createAggregateFunction()`, `registerFunction()`
- Events: `onDataChange()`, `onSchemaChange()`
- Lifecycle: `close()`

**Statement:**
- Lifecycle: `nextStatement()`, `reset()`, `finalize()`, `clearBindings()`
- Binding: `bind()`, `bindAll()`
- Execution: `run()`, `get()`, `all()`, `iterateRows()`
- Introspection: `isQuery()`, `getColumnNames()`, `getColumnDefs()`, `getParameters()`

## 2. Critical Issues

### 2.1 High Priority

#### Hash-Based Savepoint Names (Collision Risk)
**File:** `runtime/emit/transaction.ts:11-19`

```typescript
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

**Problem:** Different savepoint names can collide to the same index, causing incorrect rollback behavior.

**Recommendation:** Use a stack-based approach with actual names or unique IDs.

#### Mutex Leak in `Statement.all()`
**File:** `statement.ts:453-476`

If iteration is abandoned (not exhausted), the mutex is never released until GC. Unlike `Database.eval()`, `all()` lacks a wrapper with `return()` handling.

**Recommendation:** Add iterator wrapper with `return()` handler to release mutex on early exit.

#### Inline `require()` in `registerType`
**File:** `database.ts:962-965`

```typescript
const { registerType } = require('../types/registry.js');
```

**Problem:** Violates project convention of no inline imports.

**Recommendation:** Move to top-level import.

### 2.2 Medium Priority

#### DRY Violation: Transaction Finalization Pattern
**Files:** `statement.ts` (lines 326-334, 405-413, 436-443, 466-473), `database.ts` (lines 1171-1177)

The same pattern is repeated 5+ times:
```typescript
if (this.db._isImplicitTransaction()) {
	if (success) {
		await this.db._commitTransaction();
	} else {
		await this.db._rollbackTransaction();
	}
}
```

**Recommendation:** Extract to helper method:
```typescript
private async finalizeImplicitTransaction(success: boolean): Promise<void>
```

#### DRY Violation: Function Registration Error Handling
**File:** `database.ts` (lines 776-780, 811-816, 827-832)

Identical try-catch pattern for function registration repeated 3 times.

**Recommendation:** Extract to `registerFunctionWithErrorHandling()` helper.

#### ParseError Handling Loses Context
**File:** `database.ts:458-464`

```typescript
if (e instanceof ParseError) throw new QuereusError(`Parse error: ${e.message}`, StatusCode.ERROR, e);
```

**Problem:** Wrapping ParseError loses line/column information since ParseError already extends QuereusError.

**Recommendation:** Re-throw ParseError directly: `if (e instanceof ParseError) throw e;`

#### Parameter Binding Key Inconsistency
**File:** `statement.ts`

- `bindAll()` uses string keys: `convertedArgs[String(index + 1)]`
- `bind()` uses numeric keys: `this.boundArgs[key]`
- Constructor uses numeric keys

**Recommendation:** Standardize on numeric keys for positional parameters.

#### `hasChanges()` May Misdetect Inherited Entries
**File:** `vtab/memory/layer/transaction.ts:259-276`

The `hasChanges()` method may incorrectly detect inherited BTree entries as changes.

**Recommendation:** Verify against inheritree API for accurate layer-only change detection.

### 2.3 Lower Priority

#### Unused `normalCompletion` Variable
**File:** `database.ts:1131`

Variable is set but never used for control flow.

#### Console.error Instead of Project Logger
**File:** `database-events.ts:341-347`, `vtab/events.ts:133-139`

Error handling uses `console.error` instead of the project's `createLogger` system.

#### Double Serialization in `recordUpdate`
**File:** `database-transaction.ts:326-332`

`serializeKeyTuple()` called multiple times for the same keys.

## 3. Event System Concerns

### Memory Management
- **Listener accumulation:** No limit on registered listeners
- **No WeakRef support:** Strong references may cause memory leaks if consumers forget to unsubscribe
- **No warning on close:** `removeAllListeners()` doesn't warn about lingering listeners

### Event Ordering
- Schema events emitted before data events
- Within categories, cross-layer chronological order may not be preserved after savepoint flattening

### Recommendations
1. Add max listener count with warnings
2. Log warning if listeners remain on close
3. Document ordering guarantees
4. Consider async listener support

## 4. Test Coverage Assessment

### Well-Covered Areas
- Basic CRUD operations
- Parameter binding (positional, named, mixed)
- Event system (INSERT/UPDATE/DELETE, schema changes, batching, listeners)
- Transactions (BEGIN/COMMIT/ROLLBACK, savepoints)
- Multi-statement execution

### Critical Missing Tests

**Database Lifecycle:**
- `close()` cleans up resources
- Operations rejected after `close()`
- `exec()` and `run()` return values (`lastInsertRowid`, `changes`)

**Statement Lifecycle:**
- Operations rejected after `finalize()`
- Statement reuse after error
- Multiple `finalize()` calls (idempotency)

**Iterator Cleanup:**
- `iterate()` cleanup on completion
- `iterate()` cleanup on early exit (break/return)
- `iterate()` cleanup on error (throw during iteration)

**Integration:**
- Transaction isolation (read-your-own-writes)
- Changes visible after commit / hidden after rollback
- Error recovery and state consistency

## 5. Recommended Actions

### Phase 1: Critical Fixes
- [ ] Replace hash-based savepoint names with stack-based approach
- [ ] Add iterator wrapper to `Statement.all()` for mutex release on early exit
- [ ] Move inline `require()` to top-level import in `database.ts:962`
- [ ] Fix ParseError handling to preserve error context

### Phase 2: DRY Refactoring
- [ ] Extract transaction finalization helper method
- [ ] Extract function registration error handling helper
- [ ] Standardize parameter binding key types
- [ ] Replace `console.error` with project logger

### Phase 3: Test Coverage
- [ ] Add database lifecycle tests (close, post-close rejection)
- [ ] Add statement lifecycle tests (finalize, post-finalize rejection)
- [ ] Add iterator cleanup tests (completion, early exit, error)
- [ ] Add return value tests (`lastInsertRowid`, `changes`)
- [ ] Add transaction isolation tests

### Phase 4: Documentation
- [ ] Document event ordering guarantees
- [ ] Document listener memory management best practices
- [ ] Add JSDoc for all public methods with error conditions

## 6. Code Quality Summary

| Aspect | Rating | Notes |
|--------|--------|-------|
| Architecture | ✅ Good | Clean separation of concerns |
| Public API | ✅ Good | Comprehensive and well-designed |
| Error Handling | ⚠️ Mixed | Some inconsistency (Error vs QuereusError) |
| DRY | ⚠️ Needs Work | Several repeated patterns to extract |
| Test Coverage | ⚠️ Gaps | Lifecycle and cleanup tests needed |
| Memory Safety | ⚠️ Concerns | Mutex leak in `all()`, listener accumulation |
| Documentation | ⚠️ Incomplete | Public API needs JSDoc |

## 7. Files Reviewed

- `packages/quereus/src/core/database.ts`
- `packages/quereus/src/core/statement.ts`
- `packages/quereus/src/core/database-events.ts`
- `packages/quereus/src/core/database-transaction.ts`
- `packages/quereus/src/core/database-internal.ts`
- `packages/quereus/src/core/deferred-constraint-queue.ts`
- `packages/quereus/src/runtime/emit/transaction.ts`
- `packages/quereus/src/vtab/memory/layer/transaction.ts`
- `packages/quereus/src/vtab/events.ts`
- `packages/quereus/test/basic.spec.ts`
- `packages/quereus/test/database-events.spec.ts`
- `packages/quereus/test/multi-statement.spec.ts`
- `packages/quereus/test/parameter-types.spec.ts`
