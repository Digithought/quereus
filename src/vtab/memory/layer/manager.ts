import type { Database } from '../../../core/database.js';
import { type TableSchema, type IndexSchema, buildColumnIndexMap, columnDefToSchema } from '../../../schema/table.js';
import { type BTreeKey, type BTreeKeyForPrimary, type PrimaryModificationValue, isDeletionMarker } from '../types.js';
import { StatusCode, type SqlValue, type Row } from '../../../common/types.js';
import { BaseLayer } from './base.js';
import { TransactionLayer } from './transaction.js';
import type { Layer } from './interface.js';
import { MemoryTableConnection } from './connection.js';
import { Latches } from '../../../util/latches.js';
import { QuereusError, ConstraintError } from '../../../common/errors.js';
import { ConflictResolution, IndexConstraintOp } from '../../../common/constants.js';
import type { ColumnDef as ASTColumnDef } from '../../../parser/ast.js';
import { compareSqlValues } from '../../../util/comparison.js';
import type { ScanPlan } from './scan-plan.js';
import type { ColumnSchema } from '../../../schema/column.js';
import { scanBaseLayer } from './base-cursor.js';
import { scanTransactionLayer } from './transaction-cursor.js';
import { createPrimaryKeyFunctions, buildPrimaryKeyFromValues, type PrimaryKeyFunctions } from '../utils/primary-key.js';
import { createMemoryTableLoggers } from '../utils/logging.js';

let tableManagerCounter = 0;
const logger = createMemoryTableLoggers('layer:manager');

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

	private primaryKeyFunctions!: PrimaryKeyFunctions;

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

		this.initializePrimaryKeyFunctions();

		this.baseLayer = new BaseLayer(this.tableSchema);
		this.currentCommittedLayer = this.baseLayer;
	}

	private initializePrimaryKeyFunctions(): void {
		this.primaryKeyFunctions = createPrimaryKeyFunctions(this.tableSchema);
	}

	private get primaryKeyFromRow() {
		return this.primaryKeyFunctions.extractFromRow;
	}

	private get comparePrimaryKeys() {
		return this.primaryKeyFunctions.compare;
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
					logger.warn('Disconnect', this._tableName, 'Auto-committing pending transaction', { connectionId });
					try {
						await this.commitTransaction(connection);
					} catch (err: any) {
						logger.error('Disconnect', this._tableName, 'Implicit commit failed', { connectionId, error: err.message });
					}
				} else {
					logger.warn('Disconnect', this._tableName, 'Rolling back pending transaction', { connectionId });
					connection.rollback();
				}
			}
			this.connections.delete(connectionId);
			this.tryCollapseLayers().catch(err => {
				logger.error('Disconnect', this._tableName, 'Layer collapse failed', err);
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
		logger.debugLog(`[Commit ${connection.connectionId}] Acquired lock for ${this._tableName}`);
		try {
			if (pendingLayer.getParent() !== this.currentCommittedLayer) {
				connection.pendingTransactionLayer = null;
				connection.clearSavepoints();
				logger.warn('Commit Transaction', this._tableName, 'Stale commit detected, rolling back', { connectionId: connection.connectionId });
				throw new QuereusError(`Commit failed: concurrent update on table ${this._tableName}. Retry.`, StatusCode.BUSY);
			}
			pendingLayer.markCommitted();
			this.currentCommittedLayer = pendingLayer;
			logger.debugLog(`[Commit ${connection.connectionId}] CurrentCommittedLayer set to ${pendingLayer.getLayerId()} for ${this._tableName}`);
			connection.readLayer = pendingLayer;
			connection.pendingTransactionLayer = null;
			connection.clearSavepoints();
			this.tryCollapseLayers().catch(err => {
				logger.error('Commit Transaction', this._tableName, 'Background layer collapse error', err);
			});
		} finally {
			release();
			logger.debugLog(`[Commit ${connection.connectionId}] Released lock for ${this._tableName}`);
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
				logger.debugLog(`[Collapse] Lock busy for ${this._tableName}, skipping.`);
				return;
			}
			logger.debugLog(`[Collapse] Acquired lock for ${this._tableName}`);
			let collapsedCount = 0;

			while (this.currentCommittedLayer instanceof TransactionLayer && this.currentCommittedLayer.isCommitted()) {
				const layerToPromote = this.currentCommittedLayer as TransactionLayer;
				const parentLayer = layerToPromote.getParent();
				if (!parentLayer) {
					logger.error('Collapse Layers', this._tableName, 'Committed TransactionLayer has no parent', { layerId: layerToPromote.getLayerId() });
					break;
				}

				// Check if anyone is still using the parent layer
				let parentInUse = false;
				for (const conn of this.connections.values()) {
					if (conn.readLayer === parentLayer || conn.pendingTransactionLayer?.getParent() === parentLayer) {
						parentInUse = true;
						logger.debugLog(`[Collapse] Parent layer ${parentLayer.getLayerId()} in use by conn ${conn.connectionId}. Cannot collapse layer ${layerToPromote.getLayerId()}.`);
						break;
					}
				}
				if (parentInUse) break;

				logger.debugLog(`[Collapse] Promoting layer ${layerToPromote.getLayerId()} to become independent from parent ${parentLayer.getLayerId()} for ${this._tableName}`);

				// With inherited BTrees, "collapsing" means making the transaction layer independent
				// by calling clearBase() on its BTrees, effectively making it the new base data
				layerToPromote.clearBase();

				// Update the current committed layer to point to the parent
				// The transaction layer's BTrees are now independent and contain all the data
				this.currentCommittedLayer = parentLayer;
				logger.debugLog(`[Collapse] CurrentCommittedLayer set to ${parentLayer.getLayerId()} for ${this._tableName}`);

				// Update connections that were reading from the collapsed layer
				for (const conn of this.connections.values()) {
					if (conn.readLayer === layerToPromote) {
						// The layer is now independent, but connections can continue using it
						// In practice, they might want to read from the current committed layer
						// For now, leave them pointing to the promoted layer
						logger.debugLog(`[Collapse] Connection ${conn.connectionId} still reading from promoted layer ${layerToPromote.getLayerId()}`);
					}
				}

				collapsedCount++;
			}

			if (collapsedCount > 0) {
				logger.operation('Collapse Layers', this._tableName, { collapsedCount });
			} else {
				logger.debugLog(`[Collapse] No layers collapsed for ${this._tableName}. Current: ${this.currentCommittedLayer.getLayerId()}`);
			}
		} catch (e: any) {
			logger.error('Collapse Layers', this._tableName, e);
		} finally {
			if (release) {
				release();
				logger.debugLog(`[Collapse] Released lock for ${this._tableName}`);
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
			logger.error('lookupEffectiveValue', this._tableName, 'Currently only supports primary index for MemoryTableManager');
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
		this.validateMutationPermissions(operation);
		this.ensureTransactionLayer(connection);

		const targetLayer = connection.pendingTransactionLayer!;
		const onConflict = this.extractConflictResolution(values);
		this.cleanConflictResolutionFromValues(values);

		try {
			switch (operation) {
				case 'insert':
					return await this.performInsert(targetLayer, values, onConflict);
				case 'update':
					return await this.performUpdate(targetLayer, values, oldKeyValues, onConflict);
				case 'delete':
					return await this.performDelete(targetLayer, oldKeyValues);
				default:
					const exhaustiveCheck: never = operation;
					throw new QuereusError(`Unsupported operation: ${exhaustiveCheck}`, StatusCode.INTERNAL);
			}
		} catch (e) {
			if (e instanceof ConstraintError && onConflict === ConflictResolution.IGNORE) {
				return undefined;
			}
			throw e;
		}
	}

	private validateMutationPermissions(operation: 'insert' | 'update' | 'delete'): void {
		if (this.isReadOnly && operation !== 'insert') {
			throw new QuereusError(`Table '${this._tableName}' is read-only`, StatusCode.READONLY);
		}
	}

	private ensureTransactionLayer(connection: MemoryTableConnection): void {
		if (!connection.pendingTransactionLayer) {
			connection.begin();
		}
	}

	private extractConflictResolution(values: Row | undefined): ConflictResolution {
		return (values && (values as any)._onConflict)
			? (values as any)._onConflict as ConflictResolution
			: ConflictResolution.ABORT;
	}

	private cleanConflictResolutionFromValues(values: Row | undefined): void {
		if (values && (values as any)._onConflict) {
			delete (values as any)._onConflict;
		}
	}

	private async performInsert(
		targetLayer: TransactionLayer,
		values: Row | undefined,
		onConflict: ConflictResolution
	): Promise<Row | undefined> {
		if (!values) {
			throw new QuereusError("INSERT requires values.", StatusCode.MISUSE);
		}

		const newRowData: Row = values;
		const primaryKey = this.primaryKeyFromRow(newRowData);
		const existingRow = this.lookupEffectiveRow(primaryKey, targetLayer);

		if (existingRow !== null) {
			if (onConflict === ConflictResolution.IGNORE) return undefined;
			throw new ConstraintError(`UNIQUE constraint failed: ${this._tableName} PK.`);
		}

		targetLayer.recordUpsert(primaryKey, newRowData, null);
		return newRowData;
	}

	private async performUpdate(
		targetLayer: TransactionLayer,
		values: Row | undefined,
		oldKeyValues: Row | undefined,
		onConflict: ConflictResolution
	): Promise<Row | undefined> {
		if (!values || !oldKeyValues) {
			throw new QuereusError("UPDATE requires new values and old key values.", StatusCode.MISUSE);
		}

		const newRowData: Row = values;
		const schema = targetLayer.getSchema();
		const targetPrimaryKey = buildPrimaryKeyFromValues(oldKeyValues, schema.primaryKeyDefinition);
		const oldRowData = this.lookupEffectiveRow(targetPrimaryKey, targetLayer);

		if (!oldRowData) {
			if (onConflict === ConflictResolution.IGNORE) return undefined;
			logger.warn('UPDATE', this._tableName, 'Target row not found', {
				primaryKey: oldKeyValues.join(',')
			});
			return undefined;
		}

		const newPrimaryKey = this.primaryKeyFromRow(newRowData);
		const isPrimaryKeyChanged = this.comparePrimaryKeys(targetPrimaryKey, newPrimaryKey) !== 0;

		if (isPrimaryKeyChanged) {
			return this.performUpdateWithPrimaryKeyChange(targetLayer, targetPrimaryKey, newPrimaryKey, oldRowData, newRowData, onConflict);
		} else {
			targetLayer.recordUpsert(targetPrimaryKey, newRowData, oldRowData);
			return newRowData;
		}
	}

	private performUpdateWithPrimaryKeyChange(
		targetLayer: TransactionLayer,
		oldPrimaryKey: BTreeKeyForPrimary,
		newPrimaryKey: BTreeKeyForPrimary,
		oldRowData: Row,
		newRowData: Row,
		onConflict: ConflictResolution
	): Row | undefined {
		const existingRowAtNewKey = this.lookupEffectiveRow(newPrimaryKey, targetLayer);

		if (existingRowAtNewKey !== null) {
			if (onConflict === ConflictResolution.IGNORE) return undefined;
			throw new ConstraintError(`UNIQUE constraint failed on new PK for ${this._tableName}.`);
		}

		targetLayer.recordDelete(oldPrimaryKey, oldRowData);
		targetLayer.recordUpsert(newPrimaryKey, newRowData, null);
		return newRowData;
	}

	private async performDelete(
		targetLayer: TransactionLayer,
		oldKeyValues: Row | undefined
	): Promise<Row | undefined> {
		if (!oldKeyValues) {
			throw new QuereusError("DELETE requires key values.", StatusCode.MISUSE);
		}

		const schema = targetLayer.getSchema();
		const targetPrimaryKey = buildPrimaryKeyFromValues(oldKeyValues, schema.primaryKeyDefinition);
		const oldRowData = this.lookupEffectiveRow(targetPrimaryKey, targetLayer);

		if (!oldRowData) return undefined;

		targetLayer.recordDelete(targetPrimaryKey, oldRowData);
		return oldRowData;
	}

	public renameTable(newName: string): void {
		logger.operation('Rename Table', this._tableName, { newName });
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
					logger.warn('Add Column', this._tableName, 'Default for new col is expr; existing rows get NULL.', { columnName: newColumnSchema.name });
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
			this.initializePrimaryKeyFunctions();
			logger.operation('Add Column', this._tableName, { columnName: newColumnSchema.name });
		} catch (e: any) {
			this.baseLayer.updateSchema(originalManagerSchema);
			this.tableSchema = originalManagerSchema;
			this.initializePrimaryKeyFunctions();
			logger.error('Add Column', this._tableName, e);
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
			this.initializePrimaryKeyFunctions();
			logger.operation('Drop Column', this._tableName, { columnName });
		} catch (e: any) {
			this.baseLayer.updateSchema(originalManagerSchema);
			this.tableSchema = originalManagerSchema;
			this.initializePrimaryKeyFunctions();
			logger.error('Drop Column', this._tableName, e);
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
			this.initializePrimaryKeyFunctions();
			logger.operation('Rename Column', this._tableName, { oldName, newName: newColumnName });
		} catch (e: any) {
			this.baseLayer.updateSchema(originalManagerSchema);
			this.tableSchema = originalManagerSchema;
			this.initializePrimaryKeyFunctions();
			logger.error('Rename Column', this._tableName, e);
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
				logger.operation('Create Index', this._tableName, 'Index already exists, IF NOT EXISTS specified. Skipping creation.');
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
			logger.operation('Create Index', this._tableName, { indexName });
		} catch (e: any) {
			this.baseLayer.updateSchema(originalManagerSchema);
			this.tableSchema = originalManagerSchema;
			logger.error('Create Index', this._tableName, e);
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
					logger.operation('Drop Index', this._tableName, 'Index not on table, IF EXISTS. Skipping.');
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
			logger.operation('Drop Index', this._tableName, { indexName });
		} catch (e: any) {
			this.baseLayer.updateSchema(originalManagerSchema);
			this.tableSchema = originalManagerSchema;
			logger.error('Drop Index', this._tableName, e);
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
			logger.operation('Destroy', this._tableName, 'Manager destroyed and data cleared');
		} finally {
			release();
		}
	}

	private async ensureSchemaChangeSafety(): Promise<void> {
		if (this.currentCommittedLayer !== this.baseLayer) {
			logger.warn('Schema Change', this._tableName, 'Transaction layers exist. Attempting collapse...');
			await this.tryCollapseLayers();
			if (this.currentCommittedLayer !== this.baseLayer) {
				throw new QuereusError(
					`Cannot perform schema change on table ${this._tableName} while older transaction versions are in use by active connections. Commit/rollback active transactions and retry.`,
					StatusCode.BUSY
				);
			}
		}
		logger.debugLog(`Schema change safety check passed for ${this._tableName}. Current committed layer is base.`);
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
