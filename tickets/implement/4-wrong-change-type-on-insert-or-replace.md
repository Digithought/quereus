description: INSERT OR REPLACE emits wrong change type ('insert' instead of 'update') when replacing an existing row
dependencies: none
files:
  - packages/quereus/src/common/types.ts (UpdateResult type)
  - packages/quereus/src/runtime/emit/dml-executor.ts (auto-emit path in runInsert)
  - packages/quereus/src/vtab/memory/layer/manager.ts (performInsert — return replacedRow)
  - packages/quereus-store/src/common/store-table.ts (native event emission for REPLACE)
  - packages/quereus/test/database-events.spec.ts (add reproducing tests)
  - packages/quereus/test/vtab-events.spec.ts (add reproducing tests)
----

## Bug Summary

When `INSERT OR REPLACE` replaces an existing row, two code paths emit the wrong change type:

### Path 1: DML executor auto-emit (affects vtabs WITHOUT native event support)

In `dml-executor.ts` `runInsert()`, when `INSERT OR REPLACE` is used:
1. The vtab's `performInsert` handles the conflict internally (REPLACE resolution)
2. Returns `{ status: 'ok', row: newRowData }` — no indication a replacement occurred
3. DML executor lines 354-360 always treat this as 'insert':
   - Calls `_recordInsert()` instead of `_recordUpdate()`
   - Emits `type: 'insert'` auto-event without `oldRow` or `changedColumns`

### Path 2: quereus-store native event emission

In `store-table.ts` lines 468-474, the native event always emits `type: 'insert'` even when an existing row was found and replaced (line 436-449 checks for existing, falls through to REPLACE, but event is always 'insert').

### What's correct already

Memory vtab native events (TransactionLayer) are already correct. `recordUpsert()` at transaction.ts:192 properly checks `oldRowDataIfUpdate` and sets `type: 'update'` when replacing. The manager passes `existingRow` at manager.ts:523.

### ON CONFLICT DO UPDATE

The modern upsert syntax (`ON CONFLICT DO UPDATE`) is correct — it gets a constraint violation back from the vtab, then handles the update explicitly in the DML executor (lines 288-341), properly emitting 'update'.

### Downstream impact on quereus-sync

`sync-manager-impl.ts` `handleDataChange()` uses the event type to decide behavior:
- For 'insert', `oldRow` is undefined, so `recordColumnVersions` treats ALL columns as new
- For 'update', `oldRow` is provided, so only actually-changed columns get version bumps
- Wrong type → incorrect CRDT column version tracking → potential sync conflicts on unchanged columns

## Fix

### 1. Extend `UpdateResult` (types.ts)

Add optional `replacedRow` field to the 'ok' variant:

```typescript
export type UpdateResult =
	| { status: 'ok'; row?: Row; replacedRow?: Row }
	| { status: 'constraint'; constraint: ConstraintType; message?: string; existingRow?: Row };
```

This is backwards-compatible — existing vtab implementations that don't return `replacedRow` continue to work (treated as fresh inserts).

### 2. Memory vtab performInsert (manager.ts:522-524)

Return `replacedRow: existingRow` when doing a REPLACE:

```typescript
if (onConflict === ConflictResolution.REPLACE) {
	targetLayer.recordUpsert(primaryKey, newRowData, existingRow);
	return { status: 'ok', row: newRowData, replacedRow: existingRow };
}
```

### 3. DML executor runInsert (dml-executor.ts:349-363)

After `if (!result.row) continue;`, check for `replacedRow`:

```typescript
const replacedRow = (result as { replacedRow?: Row }).replacedRow;
if (replacedRow) {
	// Track as UPDATE, not INSERT
	const existingKeyValues = pkColumnIndicesInSchema.map(idx => replacedRow[idx]);
	const newKeyValues = pkColumnIndicesInSchema.map(idx => newRow[idx]);
	ctx.db._recordUpdate(tableKey, existingKeyValues, newKeyValues);

	if (needsAutoEvents) {
		const changedColumns: string[] = [];
		for (let i = 0; i < tableSchema.columns.length; i++) {
			if (!sqlValuesEqual(replacedRow[i], newRow[i])) {
				changedColumns.push(tableSchema.columns[i].name);
			}
		}
		emitAutoDataEvent(ctx, tableSchema, 'update', existingKeyValues, [...replacedRow], [...newRow], changedColumns);
	}

	yield flatRow;
	continue;
}
```

### 4. quereus-store store-table.ts (lines 436-481)

When `existing` is truthy and REPLACE is used, emit 'update' instead of 'insert':

```typescript
const wasReplace = !!existing;
// ... (existing put logic) ...
if (wasReplace) {
	const oldRow = deserializeRow(existing);
	const updateEvent = {
		type: 'update' as const,
		schemaName: schema.schemaName,
		tableName: schema.name,
		key: pk,
		oldRow,
		newRow: values,
	};
	// emit updateEvent
} else {
	// existing insert event logic
}
```

Also return `replacedRow` in the UpdateResult for store-table.

## TODO

### Phase 1: Reproducing tests
- Add test to `database-events.spec.ts`: INSERT OR REPLACE on existing row should emit 'update' event with correct oldRow, newRow, changedColumns
- Add test to `database-events.spec.ts`: INSERT OR REPLACE on non-existing row should emit 'insert' event
- Add test to `vtab-events.spec.ts`: INSERT OR REPLACE with native events should emit 'update'
- Add test to `vtab-events.spec.ts`: REPLACE INTO syntax (if supported) should also emit 'update'

### Phase 2: Core fix
- Extend `UpdateResult` ok variant with optional `replacedRow?: Row` in types.ts
- Update `isUpdateOk` type guard to include `replacedRow`
- Update memory vtab `performInsert` in manager.ts to return `replacedRow`
- Update DML executor `runInsert` in dml-executor.ts to check `replacedRow` and emit 'update'

### Phase 3: quereus-store fix
- Update store-table.ts INSERT path to emit 'update' event when replacing
- Update store-table.ts to return `replacedRow` in UpdateResult

### Phase 4: Verify
- Run build (`yarn build`)
- Run tests (`yarn test`)
- Confirm all new and existing tests pass
