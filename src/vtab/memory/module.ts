import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { Database } from '../../core/database.js';
import { type TableSchema, type IndexSchema } from '../../schema/table.js';
import { MemoryTable } from './table.js';
import type { VirtualTableModule } from '../module.js';
import { IndexConstraintOp } from '../../common/constants.js';
import type { IndexInfo } from '../index-info.js';
import { MemoryTableManager } from './layer/manager.js';
import type { MemoryTableConfig } from './types.js';
import { createMemoryTableLoggers } from './utils/logging.js';

const logger = createMemoryTableLoggers('module');

/**
 * A module that provides in-memory table functionality using digitree.
 * Tables created with this module persist only for the lifetime of the
 * database connection.
 */
export class MemoryTableModule implements VirtualTableModule<MemoryTable, MemoryTableConfig> {
	public readonly tables: Map<string, MemoryTableManager> = new Map();

	constructor() { }

	/**
	 * Creates a new memory table definition
	 */
	xCreate(db: Database, tableSchema: TableSchema): MemoryTable {
		// Ensure table doesn't already exist
		const tableKey = `${tableSchema.schemaName}.${tableSchema.name}`.toLowerCase();
		if (this.tables.has(tableKey)) {
			throw new QuereusError(`Memory table '${tableSchema.name}' already exists in schema '${tableSchema.schemaName}'.`, StatusCode.ERROR);
		}

		// Create the MemoryTableManager instance
		const manager = new MemoryTableManager(
			db,
			tableSchema.vtabModuleName,
			tableSchema.schemaName,
			tableSchema.name,
			tableSchema,
			tableSchema.isReadOnly ?? false
		);

		// Register the manager
		this.tables.set(tableKey, manager);
		logger.operation('Create Table', tableSchema.name, {
			schema: tableSchema.schemaName,
			readOnly: tableSchema.isReadOnly ?? false
		});

		// Create and return the MemoryTable instance
		return new MemoryTable(db, this, manager);
	}

	/**
	 * Connects to an existing memory table definition
	 */
	xConnect(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string, _options: MemoryTableConfig): MemoryTable {
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
	 * Determines the best query plan for executing a query against a memory table
	 */
	xBestIndex(db: Database, tableInfo: TableSchema, indexInfo: IndexInfo): number {
		const planningContext = this.createPlanningContext(tableInfo, indexInfo);
		const availableIndexes = this.gatherAvailableIndexes(tableInfo);
		const bestPlan = this.findBestPlan(planningContext, availableIndexes, indexInfo);
		this.populateIndexInfoOutput(indexInfo, bestPlan, availableIndexes);

		logger.debugLog(`[xBestIndex] Selected plan for ${tableInfo.name}: ${bestPlan.planType} on index ${bestPlan.indexId} (cost: ${bestPlan.cost})`);

		return StatusCode.OK;
	}

	private createPlanningContext(tableInfo: TableSchema, indexInfo: IndexInfo) {
		return {
			// Plan type constants
			PLAN_TYPE_FULL_ASC: 0,
			PLAN_TYPE_FULL_DESC: 1,
			PLAN_TYPE_EQ: 2,
			PLAN_TYPE_RANGE_ASC: 3,
			PLAN_TYPE_RANGE_DESC: 4,

			// Utility functions
			encodeIdxNum: (indexId: number, planType: number): number => {
				return (indexId << 3) | planType;
			},

			// Table size estimate for costing
			tableSize: 1000,
		};
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

	private findBestPlan(context: any, availableIndexes: IndexSchema[], indexInfo: IndexInfo) {
		let bestPlan = this.createInitialPlan(context);

		for (const [indexId, index] of availableIndexes.entries()) {
			const indexPlan = this.evaluateIndexPlan(context, index, indexId, indexInfo);
			if (indexPlan.cost < bestPlan.cost) {
				bestPlan = indexPlan;
			}
		}

		return this.ensureFallbackPlan(bestPlan, context, availableIndexes);
	}

	private createInitialPlan(context: any) {
		return {
			indexId: -1,
			planType: context.PLAN_TYPE_FULL_ASC,
			cost: context.tableSize * 10.0,
			rows: BigInt(context.tableSize),
			usedConstraintIndices: new Set<number>(),
			orderByConsumed: false,
			isDesc: false,
		};
	}

	private evaluateIndexPlan(context: any, index: IndexSchema, indexId: number, indexInfo: IndexInfo) {
		let currentPlan = this.createInitialPlan(context);
		currentPlan.indexId = indexId;

		// Evaluate equality plan
		const equalityPlan = this.evaluateEqualityPlan(context, index, indexId, indexInfo);
		if (equalityPlan && equalityPlan.cost < currentPlan.cost) {
			currentPlan = equalityPlan;
		}

		// Evaluate range plan
		const rangePlan = this.evaluateRangePlan(context, index, indexId, indexInfo, currentPlan);
		if (rangePlan && rangePlan.cost < currentPlan.cost) {
			currentPlan = rangePlan;
		}

		// Check ORDER BY consumption
		const orderOptimizedPlan = this.evaluateOrderByConsumption(context, index, indexInfo, currentPlan);
		if (orderOptimizedPlan) {
			currentPlan = orderOptimizedPlan;
		}

		return currentPlan;
	}

	private evaluateEqualityPlan(context: any, index: IndexSchema, indexId: number, indexInfo: IndexInfo) {
		const indexCols = index.columns;
		const eqConstraints = this.findEqualityConstraints(indexCols, indexInfo);

		if (!this.canUseEqualityPlan(indexCols, eqConstraints)) {
			logger.debugLog(`[xBestIndex] Cannot use EQ plan for index ${index.name} - missing constraints`);
			return null;
		}

		const planEqCost = Math.log2(context.tableSize + 1) + 1.0;
		const planEqRows = BigInt(1);

		logger.debugLog(`[xBestIndex] EQ Plan viable for index ${index.name}. Cost: ${planEqCost}`);

		return {
			indexId: indexId,
			planType: context.PLAN_TYPE_EQ,
			cost: planEqCost,
			rows: planEqRows,
			usedConstraintIndices: new Set(eqConstraints.values()),
			orderByConsumed: true,
			isDesc: false
		};
	}

	private findEqualityConstraints(indexCols: ReadonlyArray<any>, indexInfo: IndexInfo): Map<number, number> {
		const eqConstraints = new Map<number, number>();

		for (const [k, indexCol] of indexCols.entries()) {
			const colIndex = indexCol.index;
			let foundConstraint = false;

			for (let i = 0; i < indexInfo.nConstraint; i++) {
				const constraint = indexInfo.aConstraint[i];
				if (constraint.iColumn === colIndex &&
					constraint.op === IndexConstraintOp.EQ &&
					constraint.usable) {
					eqConstraints.set(colIndex, i);
					foundConstraint = true;
					logger.debugLog(`[xBestIndex] Found EQ constraint ${i} for column ${colIndex}`);
					break;
				}
			}

			if (!foundConstraint) {
				logger.debugLog(`[xBestIndex] No EQ constraint for index column ${k} (schema idx ${colIndex})`);
				return new Map(); // Can't use equality plan without all columns
			}
		}

		return eqConstraints;
	}

	private canUseEqualityPlan(indexCols: ReadonlyArray<any>, eqConstraints: Map<number, number>): boolean {
		return indexCols.length > 0 && eqConstraints.size === indexCols.length;
	}

	private evaluateRangePlan(context: any, index: IndexSchema, indexId: number, indexInfo: IndexInfo, currentPlan: any) {
		const indexCols = index.columns;
		const firstIndexColIdx = indexCols[0]?.index ?? -2;
		const rangeBounds = this.findRangeBounds(firstIndexColIdx, indexInfo);

		if (!rangeBounds.lowerBound && !rangeBounds.upperBound) {
			return null;
		}

		const planRangeRows = BigInt(Math.max(1, Math.floor(context.tableSize / 4)));
		const planRangeCost = Math.log2(context.tableSize + 1) * 2.0 + Number(planRangeRows);

		if (planRangeCost >= currentPlan.cost) {
			return null;
		}

		const usedIndices = new Set<number>();
		if (rangeBounds.lowerBound) usedIndices.add(rangeBounds.lowerBound.index);
		if (rangeBounds.upperBound) usedIndices.add(rangeBounds.upperBound.index);

		return {
			...currentPlan,
			planType: context.PLAN_TYPE_RANGE_ASC,
			cost: planRangeCost,
			rows: planRangeRows,
			usedConstraintIndices: usedIndices,
			orderByConsumed: false
		};
	}

	private findRangeBounds(firstColIndex: number, indexInfo: IndexInfo) {
		let lowerBound: { index: number; op: IndexConstraintOp; } | null = null;
		let upperBound: { index: number; op: IndexConstraintOp; } | null = null;

		for (let i = 0; i < indexInfo.nConstraint; i++) {
			const constraint = indexInfo.aConstraint[i];
			if (constraint.iColumn === firstColIndex && constraint.usable) {
				if (constraint.op === IndexConstraintOp.GT || constraint.op === IndexConstraintOp.GE) {
					if (!lowerBound || constraint.op > lowerBound.op) {
						lowerBound = { index: i, op: constraint.op };
					}
				} else if (constraint.op === IndexConstraintOp.LT || constraint.op === IndexConstraintOp.LE) {
					if (!upperBound || constraint.op < upperBound.op) {
						upperBound = { index: i, op: constraint.op };
					}
				}
			}
		}

		return { lowerBound, upperBound };
	}

	private evaluateOrderByConsumption(context: any, index: IndexSchema, indexInfo: IndexInfo, currentPlan: any) {
		if (indexInfo.nOrderBy === 0) {
			return null;
		}

		const indexCols = index.columns;
		const orderByConsumption = this.checkOrderByConsumption(indexCols, indexInfo);

		if (!orderByConsumption.canConsume) {
			return null;
		}

		const indexScanIsDesc = indexCols[0]?.desc ?? false;
		const requiresDescScan = orderByConsumption.isDesc !== indexScanIsDesc;
		const basePlanType = currentPlan.planType;

		if (basePlanType === context.PLAN_TYPE_FULL_ASC || basePlanType === context.PLAN_TYPE_RANGE_ASC) {
			return {
				...currentPlan,
				orderByConsumed: true,
				isDesc: orderByConsumption.isDesc,
				planType: this.adjustPlanTypeForOrder(context, basePlanType, requiresDescScan),
				cost: currentPlan.cost * 0.9 // Prefer consuming order
			};
		}

		return null;
	}

	private checkOrderByConsumption(indexCols: ReadonlyArray<any>, indexInfo: IndexInfo) {
		if (indexInfo.nOrderBy === 0 || indexCols.length < indexInfo.nOrderBy) {
			return { canConsume: false, isDesc: false };
		}

		const isOrderDesc = indexInfo.aOrderBy[0].desc;

		for (let k = 0; k < indexInfo.nOrderBy; k++) {
			const orderByCol = indexInfo.aOrderBy[k];
			const indexCol = indexCols[k];

			if (orderByCol.iColumn !== indexCol.index || orderByCol.desc !== isOrderDesc) {
				return { canConsume: false, isDesc: false };
			}
		}

		return { canConsume: true, isDesc: isOrderDesc };
	}

	private adjustPlanTypeForOrder(context: any, basePlanType: number, requiresDescScan: boolean) {
		if (basePlanType === context.PLAN_TYPE_FULL_ASC) {
			return requiresDescScan ? context.PLAN_TYPE_FULL_DESC : context.PLAN_TYPE_FULL_ASC;
		} else { // RANGE_ASC
			return requiresDescScan ? context.PLAN_TYPE_RANGE_DESC : context.PLAN_TYPE_RANGE_ASC;
		}
	}

	private ensureFallbackPlan(bestPlan: any, context: any, availableIndexes: IndexSchema[]) {
		if (bestPlan.indexId === -1) {
			const primaryIndex = availableIndexes.findIndex(idx => idx.name === '_primary_');
			bestPlan.indexId = primaryIndex >= 0 ? primaryIndex : 0;
			bestPlan.planType = context.PLAN_TYPE_FULL_ASC;
			bestPlan.cost = context.tableSize * 10.0;
			bestPlan.rows = BigInt(context.tableSize);
			bestPlan.usedConstraintIndices.clear();
			bestPlan.orderByConsumed = false;
		}
		return bestPlan;
	}

	private populateIndexInfoOutput(indexInfo: IndexInfo, bestPlan: any, availableIndexes: IndexSchema[]) {
		const context = this.createPlanningContext({} as TableSchema, indexInfo);

		indexInfo.idxNum = context.encodeIdxNum(bestPlan.indexId, bestPlan.planType);
		indexInfo.estimatedCost = bestPlan.cost;
		indexInfo.estimatedRows = bestPlan.rows;
		indexInfo.orderByConsumed = bestPlan.orderByConsumed;
		indexInfo.idxFlags = (bestPlan.planType === context.PLAN_TYPE_EQ) ? 1 : 0;

		this.buildConstraintUsage(indexInfo, bestPlan);
		this.buildIndexString(indexInfo, bestPlan, availableIndexes);
	}

	private buildConstraintUsage(indexInfo: IndexInfo, bestPlan: any) {
		const constraintUsage = Array.from({ length: indexInfo.nConstraint }, () => ({
			argvIndex: 0,
			omit: false
		}));

		let currentArg = 1;
		bestPlan.usedConstraintIndices.forEach((constraintIndex: number) => {
			constraintUsage[constraintIndex].argvIndex = currentArg++;
			constraintUsage[constraintIndex].omit = (bestPlan.planType === 2); // PLAN_TYPE_EQ
		});

		indexInfo.aConstraintUsage = constraintUsage;
	}

	private buildIndexString(indexInfo: IndexInfo, bestPlan: any, availableIndexes: IndexSchema[]) {
		const chosenIndex = availableIndexes[bestPlan.indexId];
		const idxStrParts = [
			`idx=${chosenIndex?.name ?? 'unknown'}(${bestPlan.indexId})`,
			`plan=${bestPlan.planType}`
		];

		if (bestPlan.orderByConsumed) {
			idxStrParts.push(`ordCons=${bestPlan.isDesc ? 'DESC' : 'ASC'}`);
		}

		if (bestPlan.usedConstraintIndices.size > 0) {
			const argvMapping = this.createArgvMapping(indexInfo.aConstraintUsage);
			if (argvMapping.length > 0) {
				idxStrParts.push(`argvMap=[${argvMapping.join(',')}]`);
			}
		}

		indexInfo.idxStr = idxStrParts.join(';');
	}

	private createArgvMapping(constraintUsage: any[]): string[] {
		return constraintUsage
			.map((usage, constraintIdx) => ({
				argIdx: usage.argvIndex,
				constraintIdx
			}))
			.filter(item => item.argIdx > 0)
			.map(item => `[${item.argIdx},${item.constraintIdx}]`);
	}

	/**
	 * Destroys a memory table and frees associated resources
	 */
	async xDestroy(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string): Promise<void> {
		const tableKey = `${schemaName.toLowerCase()}.${tableName.toLowerCase()}`;
		const manager = this.tables.get(tableKey);

		if (manager) {
			// This will call the manager's destroy method which handles cleaning up resources
			await manager.destroy?.();
			this.tables.delete(tableKey);
			logger.operation('Destroy Table', tableName, { schema: schemaName });
		}
	}
}
