import { BTree } from 'digitree';
import { IndexConstraintOp, ConflictResolution } from '../common/constants';
import { SqliteError, ConstraintError } from '../common/errors';
import { StatusCode, type SqlValue } from '../common/types';
import type { Database } from '../core/database';
import { columnDefToSchema, type TableSchema, buildColumnIndexMap } from '../schema/table';
import { Latches } from '../util/latches';
import type { IndexInfo, IndexConstraint } from './indexInfo';
import { MemoryTable, type MemoryTableConfig, type BTreeKey, type MemoryTableRow } from './memory-table';
import type { VirtualTableModule, SchemaChangeInfo } from './module';
import { MemoryTableCursor } from './memory-cursor';

/**
 * A module that provides in-memory table functionality using digitree.
 */

export class MemoryTableModule implements VirtualTableModule<MemoryTable, MemoryTableCursor, MemoryTableConfig> {
	private static SCHEMA_VERSION = 1;
	private tables: Map<string, MemoryTable> = new Map();

	constructor() { }

	xCreate(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string, options: MemoryTableConfig): MemoryTable {
		console.log(`MemoryTableModule xCreate: Creating table ${schemaName}.${tableName}`);
		const table = new MemoryTable(db, this, schemaName, tableName, options.readOnly ?? false);
		// Set columns on the table instance first. This populates table.columns.
		table.setColumns(options.columns, options.primaryKey ?? []);

		// Now, build the full ColumnSchema array for the TableSchema object.
		// Use the *options* passed in, as they contain the original dataType string needed by columnDefToSchema.
		const finalColumnSchemas = options.columns.map((optCol, index) => columnDefToSchema({
			name: optCol.name,
			dataType: optCol.type, // Pass the original string type name from options
			constraints: [
				// Synthesize constraints based on options for the helper
				...(options.primaryKey?.some(pk => pk.index === index) ? [{ type: 'primaryKey' as const }] : []),
				...(optCol.collation ? [{ type: 'collate' as const, collation: optCol.collation }] : [])
				// TODO: Add NOT NULL, DEFAULT constraints if available in options
			]
		}));

		// Now build the full TableSchema and attach it to the table instance
		const tableSchema: TableSchema = {
			name: tableName,
			schemaName: schemaName,
			columns: finalColumnSchemas, // Use the generated schemas
			columnIndexMap: buildColumnIndexMap(finalColumnSchemas), // Build map from generated schemas
			primaryKeyDefinition: options.primaryKey ?? [],
			checkConstraints: options.checkConstraints ?? [],
			isVirtual: true,
			vtabModule: this,
			vtabInstance: table,
			vtabAuxData: pAux,
			vtabArgs: [], // Args are implicitly handled by options here
			vtabModuleName: moduleName,
			// Add missing properties with default values
			isWithoutRowid: false,
			isStrict: false,
			isView: false,
		};
		table.tableSchema = Object.freeze(tableSchema);

		return table;
	}

	xConnect(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string, options: MemoryTableConfig): MemoryTable {
		console.log(`MemoryTableModule xConnect: Connecting to table ${schemaName}.${tableName}`);
		const existing = this.tables.get(`${schemaName}.${tableName}`.toLowerCase());
		if (existing) {
			return existing;
		}
		throw new SqliteError(`Internal error: Attempted to connect to non-existent memory table ${schemaName}.${tableName}`, StatusCode.INTERNAL);
	}

	async xDisconnect(table: MemoryTable): Promise<void> {
		console.log(`Memory table '${table.tableName}' disconnected`);
	}

	async xDestroy(table: MemoryTable): Promise<void> {
		table.clear();
		const tableKey = `${table.schemaName.toLowerCase()}.${table.tableName.toLowerCase()}`;
		this.tables.delete(tableKey);
		console.log(`Memory table '${table.tableName}' destroyed`);
	}

	/** Create a new cursor for scanning the virtual table. */
	async xOpen(table: MemoryTable): Promise<MemoryTableCursor> {
		if (!table.data) {
			// Initialize BTree here if not done by setColumns (e.g., if constructor doesn't call it)
			table.data = new BTree<BTreeKey, MemoryTableRow>(table.keyFromEntry, table.compareKeys);
		}
		// Simply return a new cursor instance
		return new MemoryTableCursor(table);
	}

	xBestIndex(table: MemoryTable, indexInfo: IndexInfo): number {
		// --- Add check for sorter table ---
		if (table.isSorter) {
			indexInfo.idxNum = 0; // Use plan 0 (full scan)
			indexInfo.estimatedCost = 1.0; // Very low cost
			indexInfo.estimatedRows = BigInt(table.size || 1);
			indexInfo.orderByConsumed = true; // The output *is* the sorted order
			indexInfo.idxFlags = 0;
			indexInfo.aConstraintUsage = Array.from({ length: indexInfo.nConstraint }, () => ({ argvIndex: 0, omit: false }));
			indexInfo.idxStr = "sortplan"; // Indicate this is the sort plan
			return StatusCode.OK;
		}
		// --- End sorter check ---
		const constraintUsage = Array.from({ length: indexInfo.nConstraint }, () => ({ argvIndex: 0, omit: false }));
		const pkIndices = table.primaryKeyColumnIndices;
		const keyIsRowid = pkIndices.length === 0;
		const tableSize = table.size || 1;

		const PLANS = {
			FULL_ASC: 0,
			KEY_EQ: 1,
			KEY_RANGE_ASC: 2,
			FULL_DESC: 3,
			KEY_RANGE_DESC: 4,
		};

		let bestPlan = {
			idxNum: PLANS.FULL_ASC,
			cost: tableSize * 10.0,
			rows: BigInt(tableSize),
			usedConstraintIndices: new Set<number>(),
			boundConstraintIndices: { lower: -1, upper: -1 },
			orderByConsumed: false,
			isDesc: false,
			lowerBoundOp: null as IndexConstraintOp | null,
			upperBoundOp: null as IndexConstraintOp | null,
		};

		const eqConstraintsMap = new Map<number, number>();
		let canUseEqPlan = pkIndices.length > 0;

		for (let i = 0; i < indexInfo.nConstraint; i++) {
			const constraint = indexInfo.aConstraint[i];
			if (constraint.op === IndexConstraintOp.EQ && constraint.usable) {
				if (keyIsRowid && constraint.iColumn === -1) {
					eqConstraintsMap.set(-1, i);
					break;
				} else if (pkIndices.includes(constraint.iColumn)) {
					eqConstraintsMap.set(constraint.iColumn, i);
				}
			}
		}
		if (pkIndices.length > 0) {
			for (const pkIdx of pkIndices) {
				if (!eqConstraintsMap.has(pkIdx)) {
					canUseEqPlan = false;
					break;
				}
			}
		} else {
			canUseEqPlan = eqConstraintsMap.has(-1);
		}

		if (canUseEqPlan) {
			const planEqCost = Math.log2(tableSize + 1) + 1.0;
			const planEqRows = BigInt(1);
			if (planEqCost < bestPlan.cost) {
				const usedIndices = new Set(eqConstraintsMap.values());
				bestPlan = {
					...bestPlan,
					idxNum: PLANS.KEY_EQ,
					cost: planEqCost,
					rows: planEqRows,
					usedConstraintIndices: usedIndices,
					orderByConsumed: true,
				};
			}
		}

		const firstPkIndex = pkIndices[0] ?? -1;
		let lowerBoundConstraint: { index: number; op: IndexConstraintOp; } | null = null;
		let upperBoundConstraint: { index: number; op: IndexConstraintOp; } | null = null;
		for (let i = 0; i < indexInfo.nConstraint; i++) {
			const c = indexInfo.aConstraint[i];
			if (c.iColumn === firstPkIndex && c.usable) {
				if (c.op === IndexConstraintOp.GT || c.op === IndexConstraintOp.GE) {
					if (!lowerBoundConstraint || (c.op > lowerBoundConstraint.op)) {
						lowerBoundConstraint = { index: i, op: c.op };
					}
				} else if (c.op === IndexConstraintOp.LT || c.op === IndexConstraintOp.LE) {
					if (!upperBoundConstraint || (c.op < upperBoundConstraint.op)) {
						upperBoundConstraint = { index: i, op: c.op };
					}
				}
			}
		}

		if (lowerBoundConstraint || upperBoundConstraint) {
			const planRangeRows = BigInt(Math.max(1, Math.floor(tableSize / 4)));
			const planRangeCost = Math.log2(tableSize + 1) * 2.0 + Number(planRangeRows);
			if (planRangeCost < bestPlan.cost) {
				const usedIndices = new Set<number>();
				if (lowerBoundConstraint) usedIndices.add(lowerBoundConstraint.index);
				if (upperBoundConstraint) usedIndices.add(upperBoundConstraint.index);

				bestPlan = {
					...bestPlan,
					idxNum: PLANS.KEY_RANGE_ASC,
					cost: planRangeCost,
					rows: planRangeRows,
					usedConstraintIndices: usedIndices,
					boundConstraintIndices: {
						lower: lowerBoundConstraint?.index ?? -1,
						upper: upperBoundConstraint?.index ?? -1
					},
					lowerBoundOp: lowerBoundConstraint?.op ?? null,
					upperBoundOp: upperBoundConstraint?.op ?? null,
				};
			}
		}

		let canConsumeOrder = false;
		let isOrderDesc = false;
		if (indexInfo.nOrderBy === pkIndices.length && pkIndices.length > 0) {
			canConsumeOrder = pkIndices.every((pkIdx, i) => indexInfo.aOrderBy[i].iColumn === pkIdx &&
				indexInfo.aOrderBy[i].desc === indexInfo.aOrderBy[0].desc
			);
			if (canConsumeOrder) isOrderDesc = indexInfo.aOrderBy[0].desc;
		} else if (indexInfo.nOrderBy === 1 && keyIsRowid && indexInfo.aOrderBy[0].iColumn === -1) {
			canConsumeOrder = true;
			isOrderDesc = indexInfo.aOrderBy[0].desc;
		}

		if (canConsumeOrder) {
			if (bestPlan.idxNum === PLANS.FULL_ASC || bestPlan.idxNum === PLANS.KEY_RANGE_ASC) {
				bestPlan.orderByConsumed = true;
				bestPlan.isDesc = isOrderDesc;
				if (bestPlan.idxNum === PLANS.FULL_ASC) {
					bestPlan.idxNum = isOrderDesc ? PLANS.FULL_DESC : PLANS.FULL_ASC;
					bestPlan.cost *= 0.9;
				} else {
					bestPlan.idxNum = isOrderDesc ? PLANS.KEY_RANGE_DESC : PLANS.KEY_RANGE_ASC;
					bestPlan.cost *= 0.9;
				}
			}
		}

		indexInfo.idxNum = bestPlan.idxNum;
		indexInfo.estimatedCost = bestPlan.cost;
		indexInfo.estimatedRows = bestPlan.rows;
		indexInfo.orderByConsumed = bestPlan.orderByConsumed;
		indexInfo.idxFlags = (bestPlan.idxNum === PLANS.KEY_EQ) ? 1 : 0;

		let currentArg = 1; // Reset currentArg before assigning
		bestPlan.usedConstraintIndices.forEach(constraintIndex => {
			constraintUsage[constraintIndex].argvIndex = currentArg++;
			constraintUsage[constraintIndex].omit = true;
		});
		indexInfo.aConstraintUsage = constraintUsage;

		let idxStrParts = [`plan=${bestPlan.idxNum}`];
		if (bestPlan.orderByConsumed) idxStrParts.push(`order=${bestPlan.isDesc ? 'DESC' : 'ASC'}`);
		if (bestPlan.lowerBoundOp) idxStrParts.push(`lb_op=${bestPlan.lowerBoundOp}`);
		if (bestPlan.upperBoundOp) idxStrParts.push(`ub_op=${bestPlan.upperBoundOp}`);
		if (bestPlan.usedConstraintIndices.size > 0) idxStrParts.push(`constraints=[${[...bestPlan.usedConstraintIndices].join(',')}]`);
		indexInfo.idxStr = idxStrParts.join(',');

		return StatusCode.OK;
	}

	async xUpdate(table: MemoryTable, values: SqlValue[], rowid: bigint | null): Promise<{ rowid?: bigint; }> {
		if (table.isReadOnly()) {
			throw new SqliteError(`Table '${table.tableName}' is read-only`, StatusCode.READONLY);
		}
		const release = await Latches.acquire(`MemoryTable.xUpdate:${table.schemaName}.${table.tableName}`);
		const onConflict = (values as any)._onConflict || ConflictResolution.ABORT; // Get conflict policy passed via VUpdate P4

		try {
			if (values.length === 1 && typeof values[0] === 'bigint') {
				// DELETE: values[0] is the rowid to delete
				table.deleteRow(values[0]);
				return {};
			} else if (values.length > 1 && values[0] === null) {
				// INSERT: values[0]=NULL, values[1..] are column values
				const data = Object.fromEntries(table.columns.map((col, idx) => [col.name, values[idx + 1]]));
				const addResult = table.addRow(data);
				if (addResult.rowid !== undefined) {
					return { rowid: addResult.rowid };
				} else {
					if (onConflict === ConflictResolution.IGNORE) {
						return {}; // Indicate ignore
					} else {
						const pkColName = table.getPkColNames() ?? 'rowid'; // Reuse helper
						throw new ConstraintError(`UNIQUE constraint failed: ${table.tableName}.${pkColName}`);
					}
				}
			} else if (values.length > 1 && typeof values[0] === 'bigint') {
				// UPDATE: values[0]=rowid, values[1..] are new column values
				const targetRowid = values[0];
				const data = Object.fromEntries(table.columns.map((col, idx) => [col.name, values[idx + 1]]));
				try {
					const updated = table.updateRow(targetRowid, data);
					if (!updated) throw new SqliteError(`Update failed for rowid ${targetRowid}`, StatusCode.NOTFOUND);
					return {}; // Update doesn't return rowid in this Promise structure
				} catch (e) {
					if (e instanceof ConstraintError && onConflict === ConflictResolution.IGNORE) {
						return {}; // Indicate ignore
					} else {
						throw e;
					}
				}
			} else {
				throw new SqliteError("Unsupported arguments for xUpdate", StatusCode.ERROR);
			}
		} finally {
			release();
		}
	}

	async xBegin(table: MemoryTable): Promise<void> {
		const release = await Latches.acquire(`MemoryTable.xBegin:${table.schemaName}.${table.tableName}`);
		try {
			if (table.inTransaction) {
				console.warn(`MemoryTable ${table.tableName}: Nested transaction started without savepoint support.`);
			} else {
				table.inTransaction = true;
				table.pendingInserts = new Map();
				table.pendingUpdates = new Map();
				table.pendingDeletes = new Map();
			}
		} finally {
			release();
		}
	}

	async xCommit(table: MemoryTable): Promise<void> {
		const release = await Latches.acquire(`MemoryTable.xCommit:${table.schemaName}.${table.tableName}`);
		try {
			if (!table.inTransaction) return; // Commit without begin is no-op
			if (!table.data) throw new Error("BTree missing during commit");

			// Apply pending changes
			// Order matters: Deletes, Updates (handle key changes), Inserts
			// 1. Deletes
			if (table.pendingDeletes) {
				for (const [rowid, delInfo] of table.pendingDeletes.entries()) {
					const path = table.data.find(delInfo.oldKey); // Find by original key
					if (path.on) {
						try {
							table.data.deleteAt(path);
							if (table.rowidToKeyMap) table.rowidToKeyMap.delete(rowid);
						} catch (e) {
							console.error(`Commit: Failed to delete rowid ${rowid} with key ${delInfo.oldKey}`, e);
						}
					}
				}
			}

			// 2. Updates
			if (table.pendingUpdates) {
				for (const [rowid, upInfo] of table.pendingUpdates.entries()) {
					const keyChanged = table.compareKeys(upInfo.oldKey, upInfo.newKey) !== 0;
					if (keyChanged) {
						// Delete old entry first (if it wasn't already deleted above)
						if (!table.pendingDeletes?.has(rowid)) {
							const oldPath = table.data.find(upInfo.oldKey);
							if (oldPath.on) {
								try { table.data.deleteAt(oldPath); } catch (e) { console.warn(`Commit Update: Failed to delete old key ${upInfo.oldKey}`, e); }
							}
						}
						if (table.rowidToKeyMap) table.rowidToKeyMap.delete(rowid); // Remove old mapping

						// Insert new entry
						try {
							table.data.insert(upInfo.newRow);
							if (table.rowidToKeyMap) table.rowidToKeyMap.set(rowid, upInfo.newKey);
						} catch (e) {
							console.error(`Commit: Failed to insert updated rowid ${rowid} with new key ${upInfo.newKey}`, e);
						}
					} else {
						// Update in place
						const path = table.data.find(upInfo.oldKey);
						if (path.on) {
							try { table.data.updateAt(path, upInfo.newRow); } catch (e) { console.error(`Commit: Failed to update in-place rowid ${rowid} with key ${upInfo.oldKey}`, e); }
						} else {
							console.warn(`Commit Update: Rowid ${rowid} with key ${upInfo.oldKey} not found for in-place update.`);
						}
					}
				}
			}

			// 3. Inserts
			if (table.pendingInserts) {
				for (const [key, row] of table.pendingInserts.entries()) {
					try {
						table.data.insert(row);
						if (table.rowidToKeyMap) table.rowidToKeyMap.set(row._rowid_, key);
					} catch (e) {
						console.error(`Commit: Failed to insert rowid ${row._rowid_} with key ${key}`, e);
					}
				}
			}

			// Clear transaction state
			table.pendingInserts = null;
			table.pendingUpdates = null;
			table.pendingDeletes = null;
			table.inTransaction = false;

		} finally {
			release();
		}
	}

	async xRollback(table: MemoryTable): Promise<void> {
		const release = await Latches.acquire(`MemoryTable.xRollback:${table.schemaName}.${table.tableName}`);
		try {
			if (!table.inTransaction) return; // Rollback without begin is no-op

			// Just discard pending changes
			table.pendingInserts = null;
			table.pendingUpdates = null;
			table.pendingDeletes = null;
			table.inTransaction = false;
		} finally {
			release();
		}
	}

	async xSync(table: MemoryTable): Promise<void> { }

	async xRename(table: MemoryTable, newName: string): Promise<void> {
		const oldTableKey = `${table.schemaName.toLowerCase()}.${table.tableName.toLowerCase()}`;
		const newTableKey = `${table.schemaName.toLowerCase()}.${newName.toLowerCase()}`;

		if (oldTableKey === newTableKey) return;
		if (this.tables.has(newTableKey)) {
			throw new SqliteError(`Cannot rename memory table: target name '${newName}' already exists in schema '${table.schemaName}'`);
		}

		this.tables.delete(oldTableKey);
		(table as any).tableName = newName;
		this.tables.set(newTableKey, table);

		console.log(`Memory table renamed from '${oldTableKey}' to '${newName}'`);
	}

	// --- Savepoint Hooks ---
	async xSavepoint(table: MemoryTable, savepointIndex: number): Promise<void> {
		table.createSavepoint(savepointIndex);
	}

	async xRelease(table: MemoryTable, savepointIndex: number): Promise<void> {
		table.releaseSavepoint(savepointIndex);
	}

	async xRollbackTo(table: MemoryTable, savepointIndex: number): Promise<void> {
		table.rollbackToSavepoint(savepointIndex);
	}

	// --- Add xAlterSchema implementation ---
	async xAlterSchema(table: MemoryTable, changeInfo: SchemaChangeInfo): Promise<void> {
		const lockKey = `MemoryTable.SchemaChange:${table.schemaName}.${table.tableName}`;
		const release = await Latches.acquire(lockKey);
		console.log(`MemoryTableModule xAlterSchema: Acquired lock for ${table.tableName}, change type: ${changeInfo.type}`);
		try {
			switch (changeInfo.type) {
				case 'addColumn':
					table._addColumn(changeInfo.columnDef);
					break;
				case 'dropColumn':
					table._dropColumn(changeInfo.columnName);
					break;
				case 'renameColumn':
					table._renameColumn(changeInfo.oldName, changeInfo.newName);
					break;
				default:
					// Should be exhaustive based on SchemaChangeInfo type
					throw new SqliteError(`Unsupported schema change type: ${(changeInfo as any).type}`, StatusCode.INTERNAL);
			}
		} finally {
			release();
			console.log(`MemoryTableModule xAlterSchema: Released lock for ${table.tableName}`);
		}
	}
	// --------------------------------------
}
