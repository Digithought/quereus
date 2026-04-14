import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { Database } from '../../core/database.js';
import { type TableSchema, type IndexSchema, IndexColumnSchema } from '../../schema/table.js';
import { MemoryTable } from './table.js';
import type { VirtualTableModule, SchemaChangeInfo } from '../module.js';
import { MemoryTableManager } from './layer/manager.js';
import type { MemoryTableConfig } from './types.js';
import { createMemoryTableLoggers } from './utils/logging.js';
import { AccessPlanBuilder, validateAccessPlan } from '../best-access-plan.js';
import type { BestAccessPlanRequest, BestAccessPlanResult, OrderingSpec, PredicateConstraint } from '../best-access-plan.js';
import type { VTableEventEmitter } from '../events.js';
import type { ModuleCapabilities } from '../capabilities.js';

const logger = createMemoryTableLoggers('module');

/**
 * A module that provides in-memory table functionality using BTree (inheritree).
 * Tables created with this module persist only for the lifetime of the
 * database connection.
 */
export class MemoryTableModule implements VirtualTableModule<MemoryTable, MemoryTableConfig> {
	public readonly tables: Map<string, MemoryTableManager> = new Map();
	private eventEmitter?: VTableEventEmitter;

	constructor(eventEmitter?: VTableEventEmitter) {
		this.eventEmitter = eventEmitter;
	}

	/**
	 * Get the event emitter for this module, if one was provided.
	 */
	getEventEmitter(): VTableEventEmitter | undefined {
		return this.eventEmitter;
	}

	/**
	 * Returns capability flags for this module.
	 * Memory module has built-in isolation and savepoint support.
	 */
	getCapabilities(): ModuleCapabilities {
		return {
			isolation: true,
			savepoints: true,
			persistent: false,
			secondaryIndexes: true,
			rangeScans: true,
		};
	}

	/**
	 * Creates a new memory table definition
	 */
	async create(db: Database, tableSchema: TableSchema): Promise<MemoryTable> {
		// Ensure table doesn't already exist
		const tableKey = `${tableSchema.schemaName}.${tableSchema.name}`.toLowerCase();
		if (this.tables.has(tableKey)) {
			throw new QuereusError(`Memory table '${tableSchema.name}' already exists in schema '${tableSchema.schemaName}'.`, StatusCode.ERROR);
		}

		// Create the MemoryTableManager instance with optional event emitter
		const manager = new MemoryTableManager(
			db,
			tableSchema.vtabModuleName,
			tableSchema.schemaName,
			tableSchema.name,
			tableSchema,
			tableSchema.isReadOnly ?? false,
			this.eventEmitter
		);

		// Register the manager
		this.tables.set(tableKey, manager);
		logger.operation('Create Table', tableSchema.name, {
			schema: tableSchema.schemaName,
			readOnly: tableSchema.isReadOnly ?? false
		});

		// Create the MemoryTable instance
		const table = new MemoryTable(db, this, manager);

		// Emit schema change event after table is fully created
		this.eventEmitter?.emitSchemaChange?.({
			type: 'create',
			objectType: 'table',
			schemaName: tableSchema.schemaName,
			objectName: tableSchema.name,
		});

		return table;
	}

	/**
	 * Connects to an existing memory table definition
	 */
	async connect(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string, options: MemoryTableConfig, _tableSchema?: TableSchema): Promise<MemoryTable> {
		const tableKey = `${schemaName}.${tableName}`.toLowerCase();
		const existingManager = this.tables.get(tableKey);

		if (!existingManager) {
			throw new QuereusError(`Memory table definition for '${tableName}' not found. Cannot connect.`, StatusCode.INTERNAL);
		}

		logger.operation('Connect Table', tableName, { schema: schemaName });

		// Create a new MemoryTable instance connected to the existing manager
		return new MemoryTable(db, this, existingManager, options._readCommitted);
	}

	/**
	 * Modern, type-safe access planning interface
	 */
	getBestAccessPlan(
		db: Database,
		tableInfo: TableSchema,
		request: BestAccessPlanRequest
	): BestAccessPlanResult {
		logger.debugLog(`[getBestAccessPlan] Planning access for ${tableInfo.name} with ${request.filters.length} filters`);

		// Get table size estimate for cost calculations.
		// The schema defaults estimatedRows to 0 at creation time, so treat 0 as
		// "unknown" and fall back to a reasonable default to avoid degenerate costs.
		const estimatedTableSize = request.estimatedRows || 1000;

		// Find the best access strategy
		const bestPlan = this.findBestAccessPlan(tableInfo, request, estimatedTableSize);

		// Validate the plan before returning
		validateAccessPlan(request, bestPlan);

		logger.debugLog(`[getBestAccessPlan] Selected plan: ${bestPlan.explains} (cost: ${bestPlan.cost}, rows: ${bestPlan.rows})`);

		return bestPlan;
	}

	/**
	 * Find the best access plan for the given request
	 */
	private findBestAccessPlan(
		tableInfo: TableSchema,
		request: BestAccessPlanRequest,
		estimatedTableSize: number
	): BestAccessPlanResult {
		// Pre-pass: IS NULL on NOT NULL column → impossible predicate, empty result
		for (const filter of request.filters) {
			if (filter.op === 'IS NULL') {
				const col = tableInfo.columns[filter.columnIndex];
				if (col?.notNull) {
					return AccessPlanBuilder
						.fullScan(0)
						.setCost(0)
						.setRows(0)
						.setHandledFilters(new Array(request.filters.length).fill(true))
						.setExplanation('Empty result (IS NULL on NOT NULL column)')
						.build();
				}
			}
		}

		const availableIndexes = this.gatherAvailableIndexes(tableInfo);
		let bestPlan: BestAccessPlanResult | undefined;

		// Try to find an index-based plan
		for (const index of availableIndexes) {
			const indexPlan = this.evaluateIndexAccess(index, request, estimatedTableSize);
			if (!bestPlan || indexPlan.cost < bestPlan.cost) {
				bestPlan = indexPlan;
			}
		}

		// Fallback to full scan if no index plan found
		if (!bestPlan) {
			bestPlan = AccessPlanBuilder
				.fullScan(estimatedTableSize)
				.setHandledFilters(new Array(request.filters.length).fill(false))
				.build();
		}

		// Check if we can satisfy ordering requirements
		if (request.requiredOrdering && request.requiredOrdering.length > 0) {
			bestPlan = this.adjustPlanForOrdering(bestPlan, request, availableIndexes);
		}

		// B-tree scans inherently produce rows in PK order.  Advertise this
		// when there is no explicit ORDER BY so the join rule can pick merge join.
		// When requiredOrdering is present, adjustPlanForOrdering already handled it;
		// adding PK ordering here would incorrectly claim we satisfy a different ORDER BY.
		if (!bestPlan.providesOrdering
			&& !(request.requiredOrdering && request.requiredOrdering.length > 0)
			&& tableInfo.primaryKeyDefinition && tableInfo.primaryKeyDefinition.length > 0
		) {
			const usesSecondaryIndex = bestPlan.indexName && bestPlan.indexName !== '_primary_';
			if (!usesSecondaryIndex) {
				const pkOrdering: OrderingSpec[] = tableInfo.primaryKeyDefinition.map(col => ({
					columnIndex: col.index,
					desc: false
				}));
				bestPlan = {
					...bestPlan,
					providesOrdering: pkOrdering,
					orderingIndexName: bestPlan.orderingIndexName ?? '_primary_'
				};
			}
		}

		// Prefer plans that fully handle at least one filter over pure full scans when costs tie
		if (request.filters.length > 0 && bestPlan.handledFilters?.some(Boolean) === false) {
			// Small nudge to cost to encourage using any usable index when costs are equal
			bestPlan = { ...bestPlan, cost: bestPlan.cost + 0.01, explains: `${bestPlan.explains} (no filters handled)` };
		}

		// Post-pass: mark tautological IS NOT NULL on NOT NULL columns as handled
		const mergedHandled = [...bestPlan.handledFilters];
		let anyMerged = false;
		for (let i = 0; i < request.filters.length; i++) {
			const filter = request.filters[i];
			if (filter.op === 'IS NOT NULL' && !mergedHandled[i]) {
				const col = tableInfo.columns[filter.columnIndex];
				if (col?.notNull) {
					mergedHandled[i] = true;
					anyMerged = true;
				}
			}
		}
		if (anyMerged) {
			bestPlan = { ...bestPlan, handledFilters: mergedHandled };
		}

		return bestPlan;
	}

	/**
	 * Evaluate access via a specific index
	 */
	private evaluateIndexAccess(
		index: IndexSchema,
		request: BestAccessPlanRequest,
		estimatedTableSize: number
	): BestAccessPlanResult {
		const indexCols = index.columns;
		if (indexCols.length === 0) {
			return AccessPlanBuilder.fullScan(estimatedTableSize)
				.setHandledFilters(new Array(request.filters.length).fill(false))
				.build();
		}

		// Check for equality constraints on index columns (prefix matching)
		const equalityMatches = this.findEqualityMatches(indexCols, request.filters);
		if (equalityMatches.matchCount === indexCols.length) {
			// Perfect equality match on all index columns - index seek (or multi-seek for IN)
			const seekCols = indexCols.slice(0, equalityMatches.matchCount).map(c => c.index);
			const { inCardinality } = equalityMatches;
			const isMultiSeek = inCardinality > 1;
			return AccessPlanBuilder
				.eqMatch(inCardinality)
				.setHandledFilters(equalityMatches.handledFilters)
				.setIsSet(!isMultiSeek)
				.setIndexName(index.name)
				.setSeekColumns(seekCols)
				.setExplanation(`Index ${isMultiSeek ? `multi-seek(${inCardinality})` : 'seek'} on ${index.name}`)
				.build();
		}

		// Prefix-equality + trailing-range on composite indexes
		if (equalityMatches.matchCount > 0 && equalityMatches.matchCount < indexCols.length) {
			const trailingCol = indexCols[equalityMatches.matchCount];
			const trailingRange = this.findRangeMatch(trailingCol, request.filters);
			if (trailingRange.hasRange) {
				const combinedHandled = equalityMatches.handledFilters.map(
					(eq, i) => eq || trailingRange.handledFilters[i]
				);
				const seekCols = indexCols.slice(0, equalityMatches.matchCount + 1).map(c => c.index);
				const estimatedRows = Math.max(1, Math.floor(estimatedTableSize / 8));
				return AccessPlanBuilder
					.rangeScan(estimatedRows)
					.setHandledFilters(combinedHandled)
					.setIndexName(index.name)
					.setSeekColumns(seekCols)
					.setExplanation(`Index prefix-range scan on ${index.name}`)
					.build();
			}
		}

		// Check for range constraints on first index column
		const rangeMatch = this.findRangeMatch(indexCols[0], request.filters);
		if (rangeMatch.hasRange) {
			const estimatedRangeRows = Math.max(1, Math.floor(estimatedTableSize / 4));
			const seekCols = [indexCols[0].index];
			return AccessPlanBuilder
				.rangeScan(estimatedRangeRows)
				.setHandledFilters(rangeMatch.handledFilters)
				.setIndexName(index.name)
				.setSeekColumns(seekCols)
				.setExplanation(`Index range scan on ${index.name}`)
				.build();
		}

		// Check for OR_RANGE constraint on first index column
		const orRangeMatch = this.findOrRangeMatch(indexCols[0], request.filters);
		if (orRangeMatch) {
			const rangeCount = orRangeMatch.rangeCount;
			const estimatedRangeRows = Math.max(1, Math.floor(estimatedTableSize / (4 * rangeCount)) * rangeCount);
			const seekCols = [indexCols[0].index];
			return AccessPlanBuilder
				.rangeScan(estimatedRangeRows)
				.setHandledFilters(orRangeMatch.handledFilters)
				.setIndexName(index.name)
				.setSeekColumns(seekCols)
				.setExplanation(`Index multi-range scan (${rangeCount} ranges) on ${index.name}`)
				.build();
		}

		// No useful index access - return full scan
		return AccessPlanBuilder.fullScan(estimatedTableSize)
			.setHandledFilters(new Array(request.filters.length).fill(false))
			.setExplanation(`Full scan (index ${index.name} not useful)`)
			.build();
	}

	/**
	 * Find equality matches for index columns (prefix matching).
	 * Handles `=`, single-value `IN`, and multi-value `IN` as equality constraints.
	 * Returns the total cardinality (product of IN list sizes) for cost estimation.
	 */
	private findEqualityMatches(
		indexCols: ReadonlyArray<IndexColumnSchema>,
		filters: readonly PredicateConstraint[]
	): { matchCount: number; handledFilters: boolean[]; inCardinality: number } {
		const handledFilters = new Array(filters.length).fill(false);
		let matchCount = 0;
		let inCardinality = 1;

		for (const indexCol of indexCols) {
			let foundMatch = false;
			for (let i = 0; i < filters.length; i++) {
				const filter = filters[i];
				if (filter.columnIndex !== indexCol.index || !filter.usable) continue;

				// Direct equality (value may be undefined for parameter bindings —
				// the actual value is supplied at runtime via seek key expressions)
				if (filter.op === '=') {
					handledFilters[i] = true;
					foundMatch = true;
					matchCount++;
					break;
				}

				// IN constraint — treat as equality for prefix matching
				if (filter.op === 'IN' && Array.isArray(filter.value) && (filter.value as unknown[]).length > 0) {
					handledFilters[i] = true;
					foundMatch = true;
					matchCount++;
					inCardinality *= (filter.value as unknown[]).length;
					break;
				}
			}
			if (!foundMatch) {
				break; // Can't use remaining index columns
			}
		}

		return { matchCount, handledFilters, inCardinality };
	}

	/**
	 * Find range match for a column
	 */
	private findRangeMatch(
		indexCol: IndexColumnSchema,
		filters: readonly PredicateConstraint[]
	): { hasRange: boolean; handledFilters: boolean[] } {
		const handledFilters = new Array(filters.length).fill(false);
		let hasLower = false;
		let hasUpper = false;

		for (let i = 0; i < filters.length; i++) {
			const filter = filters[i];
			if (filter.columnIndex === indexCol.index && filter.usable) {
				if (filter.op === '>' || filter.op === '>=') {
					handledFilters[i] = true;
					hasLower = true;
				} else if (filter.op === '<' || filter.op === '<=') {
					handledFilters[i] = true;
					hasUpper = true;
				}
			}
		}

		return { hasRange: hasLower || hasUpper, handledFilters };
	}

	/**
	 * Find OR_RANGE match for a column
	 */
	private findOrRangeMatch(
		indexCol: IndexColumnSchema,
		filters: readonly PredicateConstraint[]
	): { handledFilters: boolean[]; rangeCount: number } | null {
		for (let i = 0; i < filters.length; i++) {
			const filter = filters[i];
			if (filter.columnIndex === indexCol.index && filter.usable && filter.op === 'OR_RANGE') {
				const handledFilters = new Array(filters.length).fill(false);
				handledFilters[i] = true;
				const rangeCount = filter.ranges ? filter.ranges.length : 2;
				return { handledFilters, rangeCount };
			}
		}
		return null;
	}

	/**
	 * Adjust plan to account for ordering requirements
	 */
	private adjustPlanForOrdering(
		plan: BestAccessPlanResult,
		request: BestAccessPlanRequest,
		availableIndexes: IndexSchema[]
	): BestAccessPlanResult {
		// Check if any index can provide the required ordering
		for (const index of availableIndexes) {
			if (this.indexSatisfiesOrdering(index, request.requiredOrdering!)) {
				// This index can provide ordering - prefer it even if slightly more expensive
				const adjustedCost = plan.cost * 0.9; // 10% discount for avoiding sort

				return {
					...plan,
					cost: adjustedCost,
					providesOrdering: request.requiredOrdering,
					orderingIndexName: index.name,
					explains: `${plan.explains} with ordering from ${index.name}`
				};
			}
		}

		// No index can provide ordering - plan will need external sort
		return plan;
	}

	/**
	 * Check if an index can satisfy ordering requirements
	 */
	private indexSatisfiesOrdering(
		index: IndexSchema,
		requiredOrdering: readonly OrderingSpec[]
	): boolean {
		if (requiredOrdering.length > index.columns.length) {
			return false;
		}

		for (let i = 0; i < requiredOrdering.length; i++) {
			const required = requiredOrdering[i];
			const indexCol = index.columns[i];

			if (required.columnIndex !== indexCol.index ||
				required.desc !== (indexCol.desc ?? false)) {
				return false;
			}
		}

		return true;
	}

	private gatherAvailableIndexes(tableInfo: TableSchema): IndexSchema[] {
		const availableIndexes: IndexSchema[] = [];

		// Add pseudo-index for primary key
		const pkIndexSchema = {
			name: '_primary_',
			columns: tableInfo.primaryKeyDefinition
		};
		availableIndexes.push(pkIndexSchema);

		// Add secondary indexes
		availableIndexes.push(...(tableInfo.indexes ?? []));

		return availableIndexes;
	}

	/**
	 * Destroys a memory table and frees associated resources
	 */
	async destroy(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string): Promise<void> {
		const tableKey = `${schemaName}.${tableName}`.toLowerCase();
		const manager = this.tables.get(tableKey);

		if (manager) {
			// This will call the manager's destroy method which handles cleaning up resources
			await manager.destroy?.();
			this.tables.delete(tableKey);

			// Emit schema change event
			this.eventEmitter?.emitSchemaChange?.({
				type: 'drop',
				objectType: 'table',
				schemaName,
				objectName: tableName,
			});

			logger.operation('Destroy Table', tableName, { schema: schemaName });
		}
	}

	/**
	 * Renames a memory table's internal registration key.
	 * Called by the ALTER TABLE RENAME TO emitter after schema update.
	 */
	renameTable(schemaName: string, oldName: string, newName: string): void {
		const oldKey = `${schemaName}.${oldName}`.toLowerCase();
		const newKey = `${schemaName}.${newName}`.toLowerCase();
		const manager = this.tables.get(oldKey);
		if (manager) {
			manager.renameTable(newName);
			this.tables.delete(oldKey);
			this.tables.set(newKey, manager);
		}
	}

	/**
	 * Alters an existing memory table's structure (ADD/DROP/RENAME COLUMN).
	 */
	async alterTable(db: Database, schemaName: string, tableName: string, change: SchemaChangeInfo): Promise<TableSchema> {
		const tableKey = `${schemaName}.${tableName}`.toLowerCase();
		const manager = this.tables.get(tableKey);

		if (!manager) {
			throw new QuereusError(`Memory table '${tableName}' not found in schema '${schemaName}'. Cannot alter.`, StatusCode.ERROR);
		}

		switch (change.type) {
			case 'addColumn':
				await manager.addColumn(change.columnDef);
				break;
			case 'dropColumn':
				await manager.dropColumn(change.columnName);
				break;
			case 'renameColumn':
				if (!change.newColumnDefAst) {
					throw new QuereusError('RENAME COLUMN requires a new column definition AST', StatusCode.INTERNAL);
				}
				await manager.renameColumn(change.oldName, change.newColumnDefAst);
				break;
		}

		return manager.tableSchema;
	}

	/**
	 * Creates an index on a memory table
	 */
	async createIndex(db: Database, schemaName: string, tableName: string, indexSchema: IndexSchema): Promise<void> {
		const tableKey = `${schemaName}.${tableName}`.toLowerCase();
		const manager = this.tables.get(tableKey);

		if (!manager) {
			throw new QuereusError(`Memory table '${tableName}' not found in schema '${schemaName}'. Cannot create index.`, StatusCode.ERROR);
		}

		// Delegate to the manager to create the index
		await manager.createIndex(indexSchema);

		logger.operation('Create Index', indexSchema.name, {
			table: tableName,
			schema: schemaName,
			columns: indexSchema.columns.map(col => `${col.index}${col.desc ? ' DESC' : ''}`)
		});
	}

	/**
	 * Drops an index from a memory table
	 */
	async dropIndex(_db: Database, schemaName: string, tableName: string, indexName: string): Promise<void> {
		const tableKey = `${schemaName}.${tableName}`.toLowerCase();
		const manager = this.tables.get(tableKey);

		if (!manager) {
			throw new QuereusError(`Memory table '${tableName}' not found in schema '${schemaName}'. Cannot drop index.`, StatusCode.ERROR);
		}

		await manager.dropIndex(indexName);

		logger.operation('Drop Index', indexName, {
			table: tableName,
			schema: schemaName,
		});
	}
}
