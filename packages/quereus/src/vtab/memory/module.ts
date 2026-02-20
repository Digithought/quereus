import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { Database } from '../../core/database.js';
import { type TableSchema, type IndexSchema, IndexColumnSchema } from '../../schema/table.js';
import { MemoryTable } from './table.js';
import type { VirtualTableModule } from '../module.js';
import { MemoryTableManager } from './layer/manager.js';
import type { MemoryTableConfig } from './types.js';
import { createMemoryTableLoggers } from './utils/logging.js';
import { AccessPlanBuilder, validateAccessPlan } from '../best-access-plan.js';
import type { BestAccessPlanRequest, BestAccessPlanResult, OrderingSpec, PredicateConstraint } from '../best-access-plan.js';
import type { VTableEventEmitter } from '../events.js';
import type { ModuleCapabilities } from '../capabilities.js';

const logger = createMemoryTableLoggers('module');

/**
 * A module that provides in-memory table functionality using digitree.
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
	async connect(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string, _options: MemoryTableConfig, _tableSchema?: TableSchema): Promise<MemoryTable> {
		const tableKey = `${schemaName}.${tableName}`.toLowerCase();
		const existingManager = this.tables.get(tableKey);

		if (!existingManager) {
			throw new QuereusError(`Memory table definition for '${tableName}' not found. Cannot connect.`, StatusCode.INTERNAL);
		}

		logger.operation('Connect Table', tableName, { schema: schemaName });

		// Create a new MemoryTable instance connected to the existing manager
		return new MemoryTable(db, this, existingManager);
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

		// Prefer plans that fully handle at least one filter over pure full scans when costs tie
		if (request.filters.length > 0 && bestPlan.handledFilters?.some(Boolean) === false) {
			// Small nudge to cost to encourage using any usable index when costs are equal
			bestPlan = { ...bestPlan, cost: bestPlan.cost + 0.01, explains: `${bestPlan.explains} (no filters handled)` };
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
			// Perfect equality match on all index columns - index seek
			const seekCols = indexCols.slice(0, equalityMatches.matchCount).map(c => c.index);
			return AccessPlanBuilder
				.eqMatch(1)
				.setHandledFilters(equalityMatches.handledFilters)
				.setIsSet(true)
				.setIndexName(index.name)
				.setSeekColumns(seekCols)
				.setExplanation(`Index seek on ${index.name}`)
				.build();
		}

		// NOTE: Prefix-equality + trailing-range on composite indexes is not yet
		// supported at the physical scan level (partial prefix seek on composite
		// B-tree keys requires composite range bounds).  Fall through to
		// range-on-first-column check, which the runtime can execute correctly.

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

		// No useful index access - return full scan
		return AccessPlanBuilder.fullScan(estimatedTableSize)
			.setHandledFilters(new Array(request.filters.length).fill(false))
			.setExplanation(`Full scan (index ${index.name} not useful)`)
			.build();
	}

	/**
	 * Find equality matches for index columns (prefix matching).
	 * Handles both `=` and single-value `IN` as equality constraints.
	 */
	private findEqualityMatches(
		indexCols: ReadonlyArray<IndexColumnSchema>,
		filters: readonly PredicateConstraint[]
	): { matchCount: number; handledFilters: boolean[] } {
		const handledFilters = new Array(filters.length).fill(false);
		let matchCount = 0;

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

				// Single-value IN treated as equality
				if (filter.op === 'IN' && Array.isArray(filter.value) && (filter.value as unknown[]).length === 1) {
					handledFilters[i] = true;
					foundMatch = true;
					matchCount++;
					break;
				}
			}
			if (!foundMatch) {
				break; // Can't use remaining index columns
			}
		}

		return { matchCount, handledFilters };
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
}
