---
description: Expose pre-transaction (committed) state via `committed.tablename` pseudo-schema for deferred constraint/assertion evaluation
dependencies: MVCC layer system (vtab/memory/layer/), database-assertions.ts, schema-resolution.ts, emitSeqScan

---

## Overview

Enable assertions and deferred constraints to reference the committed (pre-transaction) state alongside the current state, using a `committed` pseudo-schema qualifier:

```sql
CREATE ASSERTION no_balance_decrease CHECK NOT EXISTS (
  SELECT 1 FROM accounts a
  JOIN committed.accounts ca ON a.id = ca.id
  WHERE a.balance < ca.balance
);
```

The parser already handles `schema.tablename` syntax, so `committed.accounts` parses as `{ schema: 'committed', name: 'accounts' }`. No parser changes needed.

## Architecture

### Data Flow

```
SQL: committed.accounts
  ↓ (parser — no changes needed)
AST.FromClause { type:'table', table:{ schema:'committed', name:'accounts' } }
  ↓ (planner: schema resolution)
resolveTableSchema(ctx, 'accounts', 'committed')
  → intercept 'committed', resolve real table from main/search-path
  → return real TableSchema (schemaName='main', name='accounts')
  ↓ (planner: buildTableReference)
new TableReferenceNode(scope, tableSchema, module, auxData, undefined, /*readCommitted*/ true)
  ↓ (optimizer: ruleSelectAccessPath)
SeqScanNode / IndexScanNode / IndexSeekNode (source.readCommitted accessible)
  ↓ (emitter: emitSeqScan)
module.connect(db, auxData, 'memory', 'main', 'accounts', { _readCommitted: true })
  ↓ (memory module)
MemoryTable in committed-snapshot mode
  ↓ (query)
Always reads from conn.readLayer (committed layer), never pendingTransactionLayer
```

### Key Insight

During a transaction, `MemoryTableManager.currentCommittedLayer` is the pre-transaction state. A fresh `MemoryTableConnection` via `manager.connect()` gets `readLayer = currentCommittedLayer`. Since we don't register this connection with the database or call `begin()` on it, it has no `pendingTransactionLayer` and always reads committed data.

### Savepoint Semantics

"committed" always means the transaction-start state (`currentCommittedLayer`), not a savepoint boundary. This is naturally correct because `currentCommittedLayer` doesn't change during a transaction.

## Implementation Phases

### Phase 1: `TableReferenceNode` — add `readCommitted` flag

**File:** `packages/quereus/src/planner/nodes/reference.ts`

- Add `readCommitted: boolean = false` parameter to `TableReferenceNode` constructor (after `estimatedCostOverride`)
- Store as `public readonly readCommitted: boolean`
- Include in `getLogicalAttributes()` when true

### Phase 2: Schema resolution — intercept `committed` pseudo-schema

**File:** `packages/quereus/src/planner/building/schema-resolution.ts`

In `resolveTableSchema()`, when `schemaName?.toLowerCase() === 'committed'`:
1. Strip the `committed` qualifier and resolve the underlying table from the default search path (call `ctx.schemaManager.findTable(tableName, undefined, ctx.schemaPath)`)
2. Return the real `TableSchema` (with its real `schemaName`, e.g., `'main'`)
3. The caller (`buildTableReference`) knows from the original `fromClause.table.schema` that this is a committed reference

Add a new exported helper:
```typescript
export const COMMITTED_SCHEMA = 'committed';

export function isCommittedSchemaRef(schemaName?: string): boolean {
	return schemaName?.toLowerCase() === COMMITTED_SCHEMA;
}
```

### Phase 3: `buildTableReference` — thread committed flag

**File:** `packages/quereus/src/planner/building/table.ts`

When building the `TableReferenceNode`, check if the original `fromClause.table.schema` is `'committed'` (using `isCommittedSchemaRef`). If so, pass `readCommitted: true` to the constructor.

```typescript
const readCommitted = isCommittedSchemaRef(fromClause.table.schema);
const resolvedSchemaName = readCommitted ? undefined : fromClause.table.schema;
const tableSchema = resolveTableSchema(context, fromClause.table.name, resolvedSchemaName);
// ...
const tableRef = new TableReferenceNode(context.scope, tableSchema, vtabModule, auxData, undefined, readCommitted);
```

### Phase 4: Runtime emission — pass `_readCommitted` option

**File:** `packages/quereus/src/runtime/emit/scan.ts`

In `emitSeqScan()`, inside the `run` generator, when building the options for `module.connect()`:

```typescript
const options: BaseModuleConfig = {
	...(schema.vtabArgs ?? {}),
	...(source.readCommitted ? { _readCommitted: true } : {})
};
```

**File:** `packages/quereus/src/vtab/module.ts`

Add `_readCommitted?: boolean` to `BaseModuleConfig`:
```typescript
export interface BaseModuleConfig {
	/** When true, the module should provide read-only access to the committed (pre-transaction) state */
	_readCommitted?: boolean;
}
```

### Phase 5: Memory module — committed-snapshot mode

**File:** `packages/quereus/src/vtab/memory/types.ts`

Extend `MemoryTableConfig`:
```typescript
export interface MemoryTableConfig {
	readOnly?: boolean;
	_readCommitted?: boolean;
}
```

**File:** `packages/quereus/src/vtab/memory/module.ts`

In `MemoryTableModule.connect()`, when `options._readCommitted`:
- Create a `MemoryTable` in committed-snapshot mode
- Pass the flag through to the constructor

**File:** `packages/quereus/src/vtab/memory/table.ts`

- Add `private readonly readCommitted: boolean` field to `MemoryTable`
- Accept optional `readCommitted` parameter in constructor
- `ensureConnection()`: When `readCommitted`, create a fresh connection via `manager.connect()` but do NOT register it with the database (skip `db.registerConnection()`)
- `query()`: When `readCommitted`, always use `conn.readLayer` as the start layer (skip `pendingTransactionLayer`)
- `update()`: When `readCommitted`, throw a clear error (`"Cannot modify committed-state snapshot"`)
- `disconnect()`: When `readCommitted`, call `manager.disconnect(connectionId)` to clean up the unregistered connection

### Phase 6: Read-only enforcement in planner

**Files:** `packages/quereus/src/planner/building/insert.ts`, `update.ts`, `delete.ts`

When the DML target table has schema `committed`, throw:
```
QuereusError("Cannot modify committed-state table 'committed.tablename'", StatusCode.ERROR)
```

Check early in each builder, before resolving the table.

### Phase 7: Tests

**File:** `packages/quereus/test/logic/42-committed-snapshot.sqllogic`

Test cases:
- Basic `SELECT * FROM committed.tablename` returns pre-transaction data within a transaction
- `committed.*` inside an assertion CHECK, verifying before/after comparison
- `committed.*` is read-only (INSERT/UPDATE/DELETE error)
- `committed.*` outside a transaction returns current data (no transaction layer)
- `committed.*` with JOINs between current and committed state
- Savepoint interaction: committed state doesn't change after savepoints
- Multiple tables: `committed.t1 JOIN committed.t2`
- Assertion with committed reference catches violations
- Assertion with committed reference passes when constraint holds

## Key Files

- `packages/quereus/src/planner/nodes/reference.ts` — `TableReferenceNode` (add `readCommitted`)
- `packages/quereus/src/planner/building/schema-resolution.ts` — intercept `committed` pseudo-schema
- `packages/quereus/src/planner/building/table.ts` — thread `readCommitted` to node
- `packages/quereus/src/planner/building/insert.ts` — read-only enforcement
- `packages/quereus/src/planner/building/update.ts` — read-only enforcement
- `packages/quereus/src/planner/building/delete.ts` — read-only enforcement
- `packages/quereus/src/runtime/emit/scan.ts` — pass `_readCommitted` option to `module.connect()`
- `packages/quereus/src/vtab/module.ts` — `BaseModuleConfig._readCommitted`
- `packages/quereus/src/vtab/memory/types.ts` — `MemoryTableConfig._readCommitted`
- `packages/quereus/src/vtab/memory/module.ts` — create committed-snapshot `MemoryTable`
- `packages/quereus/src/vtab/memory/table.ts` — committed-snapshot mode logic
- `packages/quereus/test/logic/42-committed-snapshot.sqllogic` — tests

## TODO

### Phase 1: TableReferenceNode
- Add `readCommitted` flag to `TableReferenceNode` constructor and expose as public readonly
- Update `getLogicalAttributes()` to include it
- Update `toString()` to show `committed.` prefix when true

### Phase 2: Schema Resolution
- Add `COMMITTED_SCHEMA` constant and `isCommittedSchemaRef()` helper
- Modify `resolveTableSchema()` to intercept `committed` schema name and resolve the real table

### Phase 3: Build Table Reference
- Modify `buildTableReference()` to detect committed refs and pass flag to `TableReferenceNode`

### Phase 4: Runtime Emission
- Add `_readCommitted` to `BaseModuleConfig`
- Modify `emitSeqScan()` to merge `_readCommitted` into connect options when `source.readCommitted`

### Phase 5: Memory Module
- Add `_readCommitted` to `MemoryTableConfig`
- Modify `MemoryTableModule.connect()` to pass flag to `MemoryTable`
- Add `readCommitted` field to `MemoryTable`
- Modify `ensureConnection()` for unregistered committed-snapshot connections
- Modify `query()` to always use `readLayer` when in committed-snapshot mode
- Block mutations in committed-snapshot mode

### Phase 6: DML Read-Only Enforcement
- Add early checks in insert, update, delete builders for `committed` schema targets

### Phase 7: Tests
- Create sqllogic test file with comprehensive test cases
