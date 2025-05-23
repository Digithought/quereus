import type { Database } from '../../../core/database.js';
import { type TableSchema, type IndexSchema, type PrimaryKeyColumnDefinition, buildColumnIndexMap, columnDefToSchema, type IndexColumnSchema } from '../../../schema/table.js';
import { type BTreeKey, type BTreeKeyForPrimary, type BTreeKeyForIndex, type PrimaryModificationValue, isDeletionMarker } from '../types.js';
import { StatusCode, type SqlValue, type Row } from '../../../common/types.js';
import { BaseLayer, createBaseLayerPkFunctions } from './base.js';
import { TransactionLayer } from './transaction.js';
import type { Layer } from './interface.js';
import { MemoryTableConnection } from './connection.js';
import { Latches } from '../../../util/latches.js';
import { QuereusError, ConstraintError } from '../../../common/errors.js';
import { ConflictResolution, IndexConstraintOp } from '../../../common/constants.js';
import type { ColumnDef as ASTColumnDef } from '../../../parser/ast.js';
import { compareSqlValues } from '../../../util/comparison.js';
import { createLogger } from '../../../common/logger.js';
import { safeJsonStringify } from '../../../util/serialization.js';
import type { ScanPlan } from './scan-plan.js';
import type { ColumnSchema } from '../../../schema/column.js';
import { scanBaseLayer } from './base-cursor.js';
import { scanTransactionLayer } from './transaction-cursor.js';

let tableManagerCounter = 0;
const log = createLogger('vtab:memory:layer:manager');
const warnLog = log.extend('warn');
const errorLog = log.extend('error');
const debugLog = log;

export class MemoryTableManager {
	public readonly managerId: number;
	public readonly db: Database;
	public readonly schemaName: string;
	private _tableName: string;
	public get tableName() { return this._tableName; }

	private baseLayer: BaseLayer;
	private currentCommittedLayer: Layer;
	private connections: Map<number, MemoryTableConnection> = new Map();
	public readonly isReadOnly: boolean;
	public tableSchema: TableSchema;

	private primaryKeyFromRow!: (row: Row) => BTreeKeyForPrimary;
	private comparePrimaryKeys!: (a: BTreeKeyForPrimary, b: BTreeKeyForPrimary) => number;

	constructor(
		db: Database,
		_moduleName: string,
		schemaName: string,
		tableName: string,
		initialSchema: TableSchema,
		readOnly: boolean = false
	) {
		this.managerId = tableManagerCounter++;
		this.db = db;
		this.schemaName = schemaName;
		this._tableName = tableName;
		this.tableSchema = initialSchema;
		this.isReadOnly = readOnly;

		this.reinitializePkFunctions();

		this.baseLayer = new BaseLayer(this.tableSchema);
		this.currentCommittedLayer = this.baseLayer;
	}

	private reinitializePkFunctions(): void {
		if (!this.tableSchema.primaryKeyDefinition || this.tableSchema.primaryKeyDefinition.length === 0) {
			throw new QuereusError(`Table '${this.tableSchema.name}' must have a primaryKeyDefinition.`, StatusCode.INTERNAL);
		}
		const pkFuncs = createBaseLayerPkFunctions(this.tableSchema);
		this.primaryKeyFromRow = pkFuncs.keyFromEntry;
		this.comparePrimaryKeys = pkFuncs.compareKeys;
	}

	public connect(): MemoryTableConnection {
		const connection = new MemoryTableConnection(this, this.currentCommittedLayer);
		this.connections.set(connection.connectionId, connection);
		return connection;
	}

	public async disconnect(connectionId: number): Promise<void> {
		const connection = this.connections.get(connectionId);
		if (connection) {
			if (connection.pendingTransactionLayer) {
				if (this.db.getAutocommit()) {
					warnLog(`Conn %d disconnecting with pending TX in autocommit; committing.`, connectionId);
					try {
						await this.commitTransaction(connection);
					} catch (err: any) {
						errorLog(`Implicit commit on disconnect for conn %d failed: %s`, connectionId, err.message);
					}
				} else {
					warnLog(`Conn %d disconnecting with pending TX (explicit TX active); rolling back.`, connectionId);
					connection.rollback();
				}
			}
			this.connections.delete(connectionId);
			this.tryCollapseLayers().catch(err => {
				errorLog(`Error during layer collapse after disconnect: %O`, err);
			});
		}
	}

	public async commitTransaction(connection: MemoryTableConnection): Promise<void> {
		if (this.isReadOnly) {
			if (connection.pendingTransactionLayer && connection.pendingTransactionLayer.hasChanges()) {
				throw new QuereusError(`Table ${this._tableName} is read-only, cannot commit changes.`, StatusCode.READONLY);
			}
			connection.pendingTransactionLayer = null;
			connection.clearSavepoints();
			return;
		}
		const pendingLayer = connection.pendingTransactionLayer;
		if (!pendingLayer) return;

		const lockKey = `MemoryTable.Commit:${this.schemaName}.${this._tableName}`;
		const release = await Latches.acquire(lockKey);
		debugLog(`[Commit %d] Acquired lock for %s`, connection.connectionId, this._tableName);
		try {
			if (pendingLayer.getParent() !== this.currentCommittedLayer) {
				connection.pendingTransactionLayer = null;
				connection.clearSavepoints();
				warnLog(`[Commit %d] Stale commit for %s. Rolling back.`, connection.connectionId, this._tableName);
				throw new QuereusError(`Commit failed: concurrent update on table ${this._tableName}. Retry.`, StatusCode.BUSY);
			}
			pendingLayer.markCommitted();
			this.currentCommittedLayer = pendingLayer;
			debugLog(`[Commit %d] CurrentCommittedLayer set to %d for %s`, connection.connectionId, pendingLayer.getLayerId(), this._tableName);
			connection.readLayer = pendingLayer;
			connection.pendingTransactionLayer = null;
			connection.clearSavepoints();
			this.tryCollapseLayers().catch(err => {
				errorLog(`[Commit %d] Background layer collapse error: %O`, connection.connectionId, err);
			});
		} finally {
			release();
			debugLog(`[Commit %d] Released lock for %s`, connection.connectionId, this._tableName);
		}
	}

	async tryCollapseLayers(): Promise<void> {
		const lockKey = `MemoryTable.Collapse:${this.schemaName}.${this._tableName}`;
		let release: (() => void) | null = null;
		try {
			const acquirePromise = Latches.acquire(lockKey);
			const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 10)); // Short timeout
			const result = await Promise.race([
				acquirePromise.then(releaseFn => ({ release: releaseFn })),
				timeoutPromise.then(() => ({ release: null }))
			]);
			release = result.release;
			if (!release) {
				debugLog(`[Collapse] Lock busy for %s, skipping.`, this._tableName);
				return;
			}
			debugLog(`[Collapse] Acquired lock for %s`, this._tableName);
			let collapsedCount = 0;

			while (this.currentCommittedLayer instanceof TransactionLayer && this.currentCommittedLayer.isCommitted()) {
				const layerToPromote = this.currentCommittedLayer as TransactionLayer;
				const parentLayer = layerToPromote.getParent();
				if (!parentLayer) {
					errorLog(`[Collapse] Committed TransactionLayer ${layerToPromote.getLayerId()} has no parent!`);
					break;
				}

				// Check if anyone is still using the parent layer
				let parentInUse = false;
				for (const conn of this.connections.values()) {
					if (conn.readLayer === parentLayer || conn.pendingTransactionLayer?.getParent() === parentLayer) {
						parentInUse = true;
						debugLog(`[Collapse] Parent layer %d in use by conn %d. Cannot collapse layer %d.`, parentLayer.getLayerId(), conn.connectionId, layerToPromote.getLayerId());
						break;
					}
				}
				if (parentInUse) break;

				debugLog(`[Collapse] Promoting layer %d to become independent from parent %d for %s`, layerToPromote.getLayerId(), parentLayer.getLayerId(), this._tableName);

				// With inherited BTrees, "collapsing" means making the transaction layer independent
				// by calling clearBase() on its BTrees, effectively making it the new base data
				layerToPromote.clearBase();

				// Update the current committed layer to point to the parent
				// The transaction layer's BTrees are now independent and contain all the data
				this.currentCommittedLayer = parentLayer;
				debugLog(`[Collapse] CurrentCommittedLayer set to %d for %s`, parentLayer.getLayerId(), this._tableName);

				// Update connections that were reading from the collapsed layer
				for (const conn of this.connections.values()) {
					if (conn.readLayer === layerToPromote) {
						// The layer is now independent, but connections can continue using it
						// In practice, they might want to read from the current committed layer
						// For now, leave them pointing to the promoted layer
						debugLog(`[Collapse] Connection %d still reading from promoted layer %d`, conn.connectionId, layerToPromote.getLayerId());
					}
				}

				collapsedCount++;
			}

			if (collapsedCount > 0) {
				debugLog(`[Collapse] Promoted %d layer(s) for %s. Current: %d`, collapsedCount, this._tableName, this.currentCommittedLayer.getLayerId());
			} else {
				debugLog(`[Collapse] No layers collapsed for ${this._tableName}. Current: %d`, this.currentCommittedLayer.getLayerId());
			}
		} catch (e: any) {
			errorLog(`[Collapse] Error for %s: %s`, this._tableName, e.message);
		} finally {
			if (release) {
				release();
				debugLog(`[Collapse] Released lock for %s`, this._tableName);
			}
		}
	}

	// With inherited BTrees, lookupEffectiveRow is much simpler
	public lookupEffectiveRow(primaryKey: BTreeKeyForPrimary, startLayer: Layer): Row | null {
		// With inherited BTrees, a simple get() will traverse the inheritance chain automatically
		const primaryTree = startLayer.getModificationTree('primary');
		if (!primaryTree) return null;

		const result = primaryTree.get(primaryKey);
		return (result === undefined || isDeletionMarker(result)) ? null : result as Row;
	}

	// Simplified for compatibility, though less relevant with inherited BTrees
	lookupEffectiveValue(key: BTreeKeyForPrimary, indexName: string | 'primary', startLayer: Layer): PrimaryModificationValue | null {
		if (indexName !== 'primary') {
			errorLog("lookupEffectiveValue currently only supports 'primary' index for MemoryTableManager");
			return null;
		}
		const primaryTree = startLayer.getModificationTree('primary');
		if (!primaryTree) return null;

		const result = primaryTree.get(key);
		return result === undefined ? null : result;
	}

	public async performMutation(
		connection: MemoryTableConnection,
		operation: 'insert' | 'update' | 'delete',
		values: Row | undefined,
		oldKeyValues?: Row
	): Promise<Row | undefined> {
		if (this.isReadOnly && operation !== 'insert') {
			throw new QuereusError(`Table '${this._tableName}' is read-only`, StatusCode.READONLY);
		}
		if (!connection.pendingTransactionLayer) connection.begin();
		const targetLayer = connection.pendingTransactionLayer!;
		const schema = targetLayer.getSchema();
		const onConflict = (values && (values as any)._onConflict)
			? (values as any)._onConflict as ConflictResolution
			: ConflictResolution.ABORT;
		if (values && (values as any)._onConflict) delete (values as any)._onConflict;

		let returnedRow: Row | undefined = undefined;

		try {
			if (operation === 'insert') {
				if (!values) throw new QuereusError("INSERT requires values.", StatusCode.MISUSE);
				const newRowData: Row = values;
				const primaryKey = this.primaryKeyFromRow(newRowData);

				// Check for existing value using inherited BTree lookup
				const existingValue = this.lookupEffectiveRow(primaryKey, targetLayer);
				if (existingValue !== null) {
					if (onConflict === ConflictResolution.IGNORE) return undefined;
					throw new ConstraintError(`UNIQUE constraint failed: ${this._tableName} PK.`);
				}
				targetLayer.recordUpsert(primaryKey, newRowData, null);
				returnedRow = newRowData;
			} else if (operation === 'update') {
				if (!values || !oldKeyValues) throw new QuereusError("UPDATE requires new values and old key values.", StatusCode.MISUSE);
				const newRowData: Row = values;
				const targetPrimaryKey = this.buildBTreeKeyFromValues(oldKeyValues, schema.primaryKeyDefinition);

				// Check if the target row exists using inherited BTree lookup
				const oldRowData = this.lookupEffectiveRow(targetPrimaryKey, targetLayer);
				if (!oldRowData) {
					if (onConflict === ConflictResolution.IGNORE) return undefined;
					warnLog(`UPDATE target PK [${oldKeyValues.join(',')}] not found for ${this._tableName}.`);
					return undefined;
				}

				const newPrimaryKey = this.primaryKeyFromRow(newRowData);
				if (this.comparePrimaryKeys(targetPrimaryKey, newPrimaryKey) !== 0) { // PK changed
					const existingValueForNewPk = this.lookupEffectiveRow(newPrimaryKey, targetLayer);
					if (existingValueForNewPk !== null) {
						if (onConflict === ConflictResolution.IGNORE) return undefined;
						throw new ConstraintError(`UNIQUE constraint failed on new PK for ${this._tableName}.`);
					}
					targetLayer.recordDelete(targetPrimaryKey, oldRowData);
					targetLayer.recordUpsert(newPrimaryKey, newRowData, null);
				} else {
					targetLayer.recordUpsert(targetPrimaryKey, newRowData, oldRowData);
				}
				returnedRow = newRowData;
			} else if (operation === 'delete') {
				if (!oldKeyValues) throw new QuereusError("DELETE requires key values.", StatusCode.MISUSE);
				const targetPrimaryKey = this.buildBTreeKeyFromValues(oldKeyValues, schema.primaryKeyDefinition);

				// Check if the target row exists using inherited BTree lookup
				const oldRowData = this.lookupEffectiveRow(targetPrimaryKey, targetLayer);
				if (!oldRowData) return undefined;

				targetLayer.recordDelete(targetPrimaryKey, oldRowData);
				returnedRow = oldRowData;
			} else {
				const exhaustiveCheck: never = operation;
				throw new QuereusError(`Unsupported operation: ${exhaustiveCheck}`, StatusCode.INTERNAL);
			}
		} catch (e) {
			if (e instanceof ConstraintError && onConflict === ConflictResolution.IGNORE) return undefined;
			throw e;
		}
		return returnedRow;
	}

	private buildBTreeKeyFromValues(keyValues: Row, pkDefinition: ReadonlyArray<PrimaryKeyColumnDefinition>): BTreeKeyForPrimary {
		if (pkDefinition.length === 0) throw new QuereusError("Cannot build BTreeKey: no PK def.", StatusCode.INTERNAL);
		if (keyValues.length !== pkDefinition.length) throw new QuereusError(`Key value count mismatch. Expected ${pkDefinition.length}, got ${keyValues.length}.`, StatusCode.INTERNAL);
		return pkDefinition.length === 1 ? keyValues[0] : keyValues;
	}

	public renameTable(newName: string): void {
		this._tableName = newName;
	}

	// --- Schema Operations (simplified with inherited BTrees) ---
	async addColumn(columnDefAst: ASTColumnDef): Promise<void> {
		if (this.isReadOnly) throw new QuereusError(`Table '${this._tableName}' is read-only`, StatusCode.READONLY);
		const lockKey = `MemoryTable.SchemaChange:${this.schemaName}.${this._tableName}`;
		const release = await Latches.acquire(lockKey);
		const originalManagerSchema = this.tableSchema;
		try {
			await this.ensureSchemaChangeSafety();
			const newColumnSchema = columnDefToSchema(columnDefAst);
			if (this.tableSchema.columns.some(c => c.name.toLowerCase() === newColumnSchema.name.toLowerCase())) {
				throw new QuereusError(`Duplicate column name: ${newColumnSchema.name}`, StatusCode.ERROR);
			}
			let defaultValue: SqlValue = null;
			const defaultConstraint = columnDefAst.constraints.find(c => c.type === 'default');
			if (defaultConstraint && defaultConstraint.expr) {
				if (defaultConstraint.expr.type === 'literal') {
					defaultValue = (defaultConstraint.expr as import('../../../parser/ast.js').LiteralExpr).value;
				} else {
					warnLog(`Default for new col '${newColumnSchema.name}' is expr; existing rows get NULL.`)
				}
			}
			const notNullConstraint = columnDefAst.constraints.find(c => c.type === 'notNull');
			if (notNullConstraint && defaultValue === null && !(defaultConstraint?.expr?.type ==='literal')) {
				throw new QuereusError(`Cannot add NOT NULL col '${newColumnSchema.name}' without DEFAULT.`, StatusCode.CONSTRAINT);
			}
			const updatedColumnsSchema: ReadonlyArray<ColumnSchema> = Object.freeze([...this.tableSchema.columns, newColumnSchema]);
			const finalNewTableSchema: TableSchema = Object.freeze({
				...this.tableSchema,
				columns: updatedColumnsSchema,
				columnIndexMap: buildColumnIndexMap(updatedColumnsSchema),
			});
			this.baseLayer.updateSchema(finalNewTableSchema);
			await this.baseLayer.addColumnToBase(newColumnSchema, defaultValue);
			this.tableSchema = finalNewTableSchema;
			this.reinitializePkFunctions();
			log(`MemoryTable ${this._tableName}: Added column ${newColumnSchema.name}`);
		} catch (e: any) {
			this.baseLayer.updateSchema(originalManagerSchema);
			this.tableSchema = originalManagerSchema;
			this.reinitializePkFunctions();
			errorLog(`Failed to add column ${columnDefAst.name}: ${e.message}`);
			throw e;
		} finally {
			release();
		}
	}

	async dropColumn(columnName: string): Promise<void> {
		if (this.isReadOnly) throw new QuereusError(`Table '${this._tableName}' is read-only`, StatusCode.READONLY);
		const lockKey = `MemoryTable.SchemaChange:${this.schemaName}.${this._tableName}`;
		const release = await Latches.acquire(lockKey);
		const originalManagerSchema = this.tableSchema;
		try {
			await this.ensureSchemaChangeSafety();
			const oldNameLower = columnName.toLowerCase();
			const colIndex = this.tableSchema.columns.findIndex(c => c.name.toLowerCase() === oldNameLower);
			if (colIndex === -1) throw new QuereusError(`Column '${columnName}' not found.`, StatusCode.ERROR);
			if (this.tableSchema.primaryKeyDefinition.some(def => def.index === colIndex)) {
				throw new QuereusError(`Cannot drop PK column "${columnName}".`, StatusCode.CONSTRAINT);
			}

			const updatedColumnsSchema = this.tableSchema.columns.filter((_, idx) => idx !== colIndex);
			const updatedPkDefinition = this.tableSchema.primaryKeyDefinition.map(def => ({
				...def, index: def.index > colIndex ? def.index - 1 : def.index
			})).filter(def => def.index !== colIndex);
			const updatedPrimaryKeyNames = updatedPkDefinition.map(def => updatedColumnsSchema[def.index]?.name).filter(Boolean) as string[];

			const updatedIndexes = (this.tableSchema.indexes || []).map(idx => ({
				...idx,
				columns: idx.columns
					.map(ic => ({ ...ic, index: ic.index > colIndex ? ic.index - 1 : ic.index }))
					.filter(ic => ic.index !== colIndex)
			})).filter(idx => idx.columns.length > 0);

			const finalNewTableSchema: TableSchema = Object.freeze({
				...this.tableSchema,
				columns: Object.freeze(updatedColumnsSchema),
				columnIndexMap: buildColumnIndexMap(updatedColumnsSchema),
				primaryKeyDefinition: Object.freeze(updatedPkDefinition),
				primaryKey: Object.freeze(updatedPrimaryKeyNames),
				indexes: Object.freeze(updatedIndexes)
			});

			this.baseLayer.updateSchema(finalNewTableSchema);
			await this.baseLayer.dropColumnFromBase(colIndex);
			this.tableSchema = finalNewTableSchema;
			this.reinitializePkFunctions();
			log(`MemoryTable ${this._tableName}: Dropped column ${columnName}`);
		} catch (e: any) {
			this.baseLayer.updateSchema(originalManagerSchema);
			this.tableSchema = originalManagerSchema;
			this.reinitializePkFunctions();
			errorLog(`Failed to drop column ${columnName}: ${e.message}`);
			throw e;
		} finally {
			release();
		}
	}

	async renameColumn(oldName: string, newColumnDefAst: ASTColumnDef): Promise<void> {
		if (this.isReadOnly) throw new QuereusError(`Table '${this._tableName}' is read-only`, StatusCode.READONLY);
		const lockKey = `MemoryTable.SchemaChange:${this.schemaName}.${this._tableName}`;
		const release = await Latches.acquire(lockKey);
		const originalManagerSchema = this.tableSchema;
		try {
			await this.ensureSchemaChangeSafety();
			const oldNameLower = oldName.toLowerCase();
			const newColumnName = newColumnDefAst.name;
			const newNameLower = newColumnName.toLowerCase();
			const colIndex = this.tableSchema.columns.findIndex(c => c.name.toLowerCase() === oldNameLower);
			if (colIndex === -1) throw new QuereusError(`Column '${oldName}' not found.`, StatusCode.ERROR);
			if (oldNameLower !== newNameLower && this.tableSchema.columns.some((c, i) => i !== colIndex && c.name.toLowerCase() === newNameLower)) {
				throw new QuereusError(`Target name '${newColumnName}' already exists.`, StatusCode.ERROR);
			}

			const newColumnSchemaAtIndex = columnDefToSchema(newColumnDefAst);
			const updatedCols = this.tableSchema.columns.map((c, i) => i === colIndex ? newColumnSchemaAtIndex : c);
			const updatedIndexes = (this.tableSchema.indexes || []).map(idx => ({
				...idx,
				columns: idx.columns.map(ic =>
					ic.index === colIndex ? { ...ic, name: newColumnName } : ic
				)
			}));

			const finalNewTableSchema: TableSchema = Object.freeze({
				...this.tableSchema,
				columns: Object.freeze(updatedCols),
				columnIndexMap: buildColumnIndexMap(updatedCols),
				primaryKeyDefinition: Object.freeze(this.tableSchema.primaryKeyDefinition),
				indexes: Object.freeze(updatedIndexes),
			});

			this.baseLayer.updateSchema(finalNewTableSchema);
			await this.baseLayer.handleColumnRename();
			this.tableSchema = finalNewTableSchema;
			this.reinitializePkFunctions();
			log(`Renamed column ${oldName} to ${newColumnName} in ${this._tableName}`);
		} catch (e: any) {
			this.baseLayer.updateSchema(originalManagerSchema);
			this.tableSchema = originalManagerSchema;
			this.reinitializePkFunctions();
			errorLog(`Failed to rename column ${oldName} to ${newColumnDefAst.name}: ${e.message}`);
			throw e;
		} finally {
			release();
		}
	}

	async createIndex(newIndexSchemaEntry: IndexSchema, ifNotExistsFromAst?: boolean): Promise<void> {
		if (this.isReadOnly) throw new QuereusError(`Table '${this._tableName}' is read-only`, StatusCode.READONLY);
		const lockKey = `MemoryTable.SchemaChange:${this.schemaName}.${this._tableName}`;
		const release = await Latches.acquire(lockKey);
		const originalManagerSchema = this.tableSchema;
		try {
			await this.ensureSchemaChangeSafety();

			const indexName = newIndexSchemaEntry.name;
			if (this.tableSchema.indexes?.some(idx => idx.name.toLowerCase() === indexName.toLowerCase())) {
				if (!ifNotExistsFromAst) {
					throw new QuereusError(`Index '${indexName}' already exists on table '${this._tableName}'.`, StatusCode.ERROR);
				}
				log(`Index '${indexName}' already exists, IF NOT EXISTS specified. Skipping creation.`);
				return;
			}

			for (const iCol of newIndexSchemaEntry.columns) {
				if (iCol.index < 0 || iCol.index >= this.tableSchema.columns.length) {
					throw new QuereusError(`Column index ${iCol.index} for index '${indexName}' is out of bounds for table '${this._tableName}'.`, StatusCode.ERROR);
				}
			}

			const finalNewTableSchema: TableSchema = Object.freeze({
				...this.tableSchema,
				indexes: Object.freeze([...(this.tableSchema.indexes || []), newIndexSchemaEntry])
			});

			this.baseLayer.updateSchema(finalNewTableSchema);
			await this.baseLayer.addIndexToBase(newIndexSchemaEntry);

			this.tableSchema = finalNewTableSchema;
			log(`MemoryTable ${this._tableName}: Created index ${indexName}`);
		} catch (e: any) {
			this.baseLayer.updateSchema(originalManagerSchema);
			this.tableSchema = originalManagerSchema;
			errorLog(`Failed to create index ${newIndexSchemaEntry.name}: ${e.message}`);
			throw e;
		} finally {
			release();
		}
	}

	async dropIndex(indexName: string, ifExists?: boolean): Promise<void> {
		if (this.isReadOnly) throw new QuereusError(`Table '${this._tableName}' is read-only`, StatusCode.READONLY);
		const lockKey = `MemoryTable.SchemaChange:${this.schemaName}.${this._tableName}`;
		const release = await Latches.acquire(lockKey);
		const originalManagerSchema = this.tableSchema;
		try {
			await this.ensureSchemaChangeSafety();
			const indexNameLower = indexName.toLowerCase();
			const indexExists = this.tableSchema.indexes?.some(idx => idx.name.toLowerCase() === indexNameLower);
			if (!indexExists) {
				if (ifExists) {
					log(`Index '${indexName}' not on table '${this._tableName}', IF EXISTS. Skipping.`);
					return;
				}
				throw new QuereusError(`Index '${indexName}' not on table '${this._tableName}'.`, StatusCode.ERROR);
			}
			const finalNewTableSchema: TableSchema = Object.freeze({
				...this.tableSchema,
				indexes: Object.freeze((this.tableSchema.indexes || []).filter(idx => idx.name.toLowerCase() !== indexNameLower))
			});
			this.baseLayer.updateSchema(finalNewTableSchema);
			await this.baseLayer.dropIndexFromBase(indexName);
			this.tableSchema = finalNewTableSchema;
			log(`MemoryTable ${this._tableName}: Dropped index ${indexName}`);
		} catch (e: any) {
			this.baseLayer.updateSchema(originalManagerSchema);
			this.tableSchema = originalManagerSchema;
			errorLog(`Failed to drop index ${indexName}: ${e.message}`);
			throw e;
		} finally {
			release();
		}
	}

	public planAppliesToKey(
		plan: ScanPlan,
		key: BTreeKey,
		keyComparator: (a: BTreeKey, b: BTreeKey) => number
	): boolean {
		if (plan.equalityKey !== undefined) {
			return keyComparator(key, plan.equalityKey) === 0;
		}
		const keyForBoundComparison = Array.isArray(key) ? key[0] : key;
		if (plan.lowerBound && (keyForBoundComparison !== undefined && keyForBoundComparison !== null)) {
			const cmp = compareSqlValues(keyForBoundComparison, plan.lowerBound.value);
			if (cmp < 0 || (cmp === 0 && plan.lowerBound.op === IndexConstraintOp.GT)) return false;
		}
		if (plan.upperBound && (keyForBoundComparison !== undefined && keyForBoundComparison !== null)) {
			const cmp = compareSqlValues(keyForBoundComparison, plan.upperBound.value);
			if (cmp > 0 || (cmp === 0 && plan.upperBound.op === IndexConstraintOp.LT)) return false;
		}
		return true;
	}

	public async destroy(): Promise<void> {
		const lockKey = `MemoryTable.Destroy:${this.schemaName}.${this._tableName}`;
		const release = await Latches.acquire(lockKey);
		try {
			for (const connection of this.connections.values()) {
				if (connection.pendingTransactionLayer) connection.rollback();
			}
			this.connections.clear();
			this.currentCommittedLayer = this.baseLayer;
			this.baseLayer = new BaseLayer(this.tableSchema);
			log(`MemoryTable %s manager destroyed and data cleared.`, this._tableName);
		} finally {
			release();
		}
	}

	private async ensureSchemaChangeSafety(): Promise<void> {
		if (this.currentCommittedLayer !== this.baseLayer) {
			warnLog(`Schema change on '%s' while transaction layers exist. Attempting collapse...`, this._tableName);
			await this.tryCollapseLayers();
			if (this.currentCommittedLayer !== this.baseLayer) {
				throw new QuereusError(
					`Cannot perform schema change on table ${this._tableName} while older transaction versions are in use by active connections. Commit/rollback active transactions and retry.`,
					StatusCode.BUSY
				);
			}
		}
		debugLog(`Schema change safety check passed for %s. Current committed layer is base.`, this._tableName);
	}

	// New method to abstract layer scanning
	public async* scanLayer(layer: Layer, plan: ScanPlan): AsyncIterable<Row> {
		if (layer instanceof TransactionLayer) {
			const parentLayer = layer.getParent();
			if (!parentLayer) {
				throw new QuereusError("TransactionLayer encountered without a parent layer during scan.", StatusCode.INTERNAL);
			}
			// With inherited BTrees, scanning is much simpler - we just scan the layer's BTrees directly
			// The inheritance is handled automatically by the BTree
			yield* scanTransactionLayer(layer, plan, this.scanLayer(parentLayer, plan));
		} else if (layer instanceof BaseLayer) {
			yield* scanBaseLayer(layer, plan);
		} else {
			throw new QuereusError("Encountered an unknown layer type during scanLayer operation.", StatusCode.INTERNAL);
		}
	}
}
