import { SqliteError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { Database } from '../../core/database.js';
import { columnDefToSchema, type TableSchema, buildColumnIndexMap, type IndexSchema } from '../../schema/table.js';
import { MemoryTable } from './table.js';
import type { VirtualTableModule } from '../module.js';
import { IndexConstraintOp } from '../../common/constants.js';
import type { IndexInfo } from '../indexInfo.js';
import { MemoryTableManager } from './layer/manager.js';
import type { MemoryTableConfig } from './types.js';
import { createLogger } from '../../common/logger.js';
import { SqlDataType } from '../../common/types.js';

const log = createLogger('vtab:memory:module');
const debugLog = log.extend('debug');

/**
 * A module that provides in-memory table functionality using digitree.
 * Tables created with this module persist only for the lifetime of the
 * database connection.
 */
export class MemoryTableModule implements VirtualTableModule<MemoryTable, MemoryTableConfig> {
	private static SCHEMA_VERSION = 2; // Reverted version, cursor model is back
	public readonly tables: Map<string, MemoryTableManager> = new Map();

	constructor() { }

	/**
	 * Creates a new memory table definition
	 */
	xCreate(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string, options: MemoryTableConfig): MemoryTable {
		// Ensure table doesn't already exist
		const tableKey = `${schemaName}.${tableName}`.toLowerCase();
		if (this.tables.has(tableKey)) {
			throw new SqliterError(`Memory table '${tableName}' already exists in schema '${schemaName}'.`, StatusCode.ERROR);
		}

		// Build the full ColumnSchema array for the TableSchema
		const finalColumnSchemas = options.columns.map((optCol, index) => columnDefToSchema({
			name: optCol.name,
			dataType: optCol.type,
			constraints: [
				...(options.primaryKey?.some(pk => pk.index === index) ? [{ type: 'primaryKey' as const }] : []),
				...(optCol.collation ? [{ type: 'collate' as const, collation: optCol.collation }] : []),
			]
		}));

		// Build IndexSchema array for TableSchema
		const finalIndexSchemas: IndexSchema[] = (options.indexes ?? []).map((indexSpec, i) => {
			const indexName = indexSpec.name ?? `_auto_${i + 1}`;
			// Map the structure for validation during addIndex
			const indexColumns = indexSpec.columns.map(c => ({
				index: c.index,
				desc: c.desc,
				collation: c.collation,
			}));
			return Object.freeze({
				name: indexName,
				columns: indexColumns,
			});
		});

		// Build and freeze the definitive TableSchema
		const tableSchema = {
			name: tableName,
			schemaName: schemaName,
			columns: finalColumnSchemas,
			columnIndexMap: buildColumnIndexMap(finalColumnSchemas),
			primaryKeyDefinition: options.primaryKey ?? [],
			checkConstraints: (options.checkConstraints ?? []) as unknown as any[],
			indexes: Object.freeze(finalIndexSchemas),
			vtabModule: this,
			vtabAuxData: pAux,
			vtabArgs: [],
			vtabModuleName: moduleName,
			isWithoutRowid: false,
			isStrict: false,
			isView: false,
		} as unknown as TableSchema; // Handle type incompatibilities with double casting

		// Create the MemoryTableManager instance
		const manager = new MemoryTableManager(
			db,
			this,
			pAux,
			moduleName,
			schemaName,
			tableName,
			tableSchema,
			options.readOnly ?? false
		);

		// Register the manager
		this.tables.set(tableKey, manager);

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
			throw new SqliterError(`Memory table definition for '${tableName}' not found. Cannot connect.`, StatusCode.INTERNAL);
		}

		// Create a new MemoryTable instance connected to the existing manager
		return new MemoryTable(db, this, existingManager);
	}

	/**
	 * Determines the best query plan for executing a query against a memory table
	 */
	xBestIndex(db: Database, tableInfo: TableSchema, indexInfo: IndexInfo): number {
		// Constants for planning
		const PLAN_TYPE_FULL_ASC = 0;
		const PLAN_TYPE_FULL_DESC = 1;
		const PLAN_TYPE_EQ = 2;
		const PLAN_TYPE_RANGE_ASC = 3;
		const PLAN_TYPE_RANGE_DESC = 4;

		const encodeIdxNum = (indexId: number, planType: number): number => {
			// Shift index ID left by 3 bits, OR with plan type
			// Max 8 plan types (0-7), leaves bits for index ID
			return (indexId << 3) | planType;
		};

		// Gather available indexes
		// 1. Create a pseudo-index for the primary key (or rowid)
		let pkIndexSchema: IndexSchema | null = null;
		if (tableInfo.primaryKeyDefinition.length > 0) {
			// Explicit PRIMARY KEY constraint exists
			pkIndexSchema = { name: '_primary_', columns: tableInfo.primaryKeyDefinition };
		} else if (tableInfo.columns.length > 0 && tableInfo.columns[0].affinity === SqlDataType.INTEGER) {
			// No explicit PK, but first column is INTEGER - treat it as implicit PK for planning
			// If the schema already reflects it as PK, use its index
			pkIndexSchema = { name: '_primary_', columns: [{ index: 0, desc: false }] }; // Assume index 0 is implicit PK
		} else {
			// No explicit PK and first column isn't INTEGER, use rowid
			pkIndexSchema = { name: '_rowid_', columns: [{ index: -1, desc: false }] };
		}

		const availableIndexes: IndexSchema[] = [];
		if (pkIndexSchema) availableIndexes.push(pkIndexSchema);
		availableIndexes.push(...(tableInfo.indexes ?? []));

		// Initialize best plan search
		const tableSize = 1000; // Placeholder estimate
		let bestPlan = {
			indexId: -1,
			planType: PLAN_TYPE_FULL_ASC,
			cost: tableSize * 10.0, // Base cost for full scan
			rows: BigInt(tableSize),
			usedConstraintIndices: new Set<number>(),
			orderByConsumed: false,
			isDesc: false,
		};

		// Evaluate each index
		availableIndexes.forEach((index, indexId) => {
			let currentPlan = {
				indexId: indexId,
				planType: PLAN_TYPE_FULL_ASC,
				cost: tableSize * 10.0,
				rows: BigInt(tableSize),
				usedConstraintIndices: new Set<number>(),
				orderByConsumed: false,
				isDesc: false,
			};
			const indexCols = index.columns;
			const firstIndexColIdx = indexCols[0]?.index ?? -2;

			// 1. Check for Equality Plan (EQ)
			const eqConstraintsMap = new Map<number, number>();
			let canUseEqPlan = true;
			const eqPlanUsedIndices = new Set<number>();
			debugLog(`[xBestIndex EQ Check] Index: ${index.name} (${indexId})`);
			for (let k = 0; k < indexCols.length; k++) {
				const idxCol = indexCols[k].index;
				let foundEq = false;
				debugLog(`  - Checking Index Col ${k} (schema idx ${idxCol})`);
				for (let i = 0; i < indexInfo.nConstraint; i++) {
					const c = indexInfo.aConstraint[i];
					debugLog(`    - Comparing with constraint ${i}: col=${c.iColumn}, op=${c.op}, usable=${c.usable}`);
					if (c.iColumn === idxCol && c.op === IndexConstraintOp.EQ && c.usable) {
						eqConstraintsMap.set(idxCol, i);
						eqPlanUsedIndices.add(i);
						foundEq = true;
						debugLog(`      -> Found usable EQ constraint ${i}`);
						break;
					}
				}
				if (!foundEq) {
					debugLog(`    - No usable EQ constraint found for index col ${k}. Cannot use EQ plan.`);
					canUseEqPlan = false;
					break; // Need equality on all index columns for this plan
				}
			}
			// Update bestPlan directly if EQ is better than the initial full scan
			if (canUseEqPlan && indexCols.length > 0) {
				const planEqCost = Math.log2(tableSize + 1) + 1.0; // Lower cost for direct lookup
				const planEqRows = BigInt(1);
				debugLog(`  - EQ Plan viable for index ${index.name}. Cost: ${planEqCost} vs Best: ${bestPlan.cost}`);
				// Compare against bestPlan found so far for *any* index
				if (planEqCost < bestPlan.cost) {
					debugLog(`    -> EQ Plan is new best plan.`);
					bestPlan = { // Update overall best plan directly
						indexId: indexId, // Use the current indexId
						planType: PLAN_TYPE_EQ,
						cost: planEqCost,
						rows: planEqRows,
						usedConstraintIndices: eqPlanUsedIndices,
						orderByConsumed: true, // Equality scan implies order
						isDesc: false // EQ plan is not inherently desc
					};
				}
				// Also update currentPlan in case range/order checks improve it further
				// Though unlikely for EQ plan
				if (planEqCost < currentPlan.cost) {
					currentPlan = {
						...currentPlan,
						planType: PLAN_TYPE_EQ,
						cost: planEqCost,
						rows: planEqRows,
						usedConstraintIndices: eqPlanUsedIndices,
						orderByConsumed: true
					};
				}
			}

			// 2. Check for Range Plan (RANGE_ASC/RANGE_DESC)
			let lowerBoundConstraint: { index: number; op: IndexConstraintOp; } | null = null;
			let upperBoundConstraint: { index: number; op: IndexConstraintOp; } | null = null;
			for (let i = 0; i < indexInfo.nConstraint; i++) {
				const c = indexInfo.aConstraint[i];
				// Only consider bounds on the first column of the index
				if (c.iColumn === firstIndexColIdx && c.usable) {
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
				if (planRangeCost < currentPlan.cost) {
					const usedIndices = new Set<number>();
					if (lowerBoundConstraint) usedIndices.add(lowerBoundConstraint.index);
					if (upperBoundConstraint) usedIndices.add(upperBoundConstraint.index);
					currentPlan = {
						...currentPlan,
						planType: PLAN_TYPE_RANGE_ASC,
						cost: planRangeCost,
						rows: planRangeRows,
						usedConstraintIndices: usedIndices,
						orderByConsumed: false
					};
				}
			}

			// 3. Check ORDER BY Consumption
			let canConsumeOrder = false;
			let isOrderDesc = false;
			if (indexInfo.nOrderBy > 0 && indexCols.length >= indexInfo.nOrderBy) {
				isOrderDesc = indexInfo.aOrderBy[0].desc;
				canConsumeOrder = true;
				for(let k=0; k< indexInfo.nOrderBy; k++) {
					const orderByCol = indexInfo.aOrderBy[k];
					const indexCol = indexCols[k];
					if (orderByCol.iColumn !== indexCol.index || orderByCol.desc !== isOrderDesc) {
						canConsumeOrder = false;
						break;
					}
				}
			}

			if (canConsumeOrder) {
				const indexScanIsDesc = indexCols[0]?.desc ?? false;
				const requiresDescScan = isOrderDesc !== indexScanIsDesc;
				const basePlanType = currentPlan.planType;

				if (basePlanType === PLAN_TYPE_FULL_ASC || basePlanType === PLAN_TYPE_RANGE_ASC) {
					currentPlan.orderByConsumed = true;
					currentPlan.isDesc = isOrderDesc;
					if (basePlanType === PLAN_TYPE_FULL_ASC) {
						currentPlan.planType = requiresDescScan ? PLAN_TYPE_FULL_DESC : PLAN_TYPE_FULL_ASC;
					} else { // RANGE_ASC
						currentPlan.planType = requiresDescScan ? PLAN_TYPE_RANGE_DESC : PLAN_TYPE_RANGE_ASC;
					}
					currentPlan.cost *= 0.9; // Prefer consuming order
				}
			}

			// 4. Update Best Plan if Current is Better (final check for this index)
			// This check is now potentially redundant if EQ already updated bestPlan,
			// but keep it for range/order plans that might beat the initial bestPlan.
			if (currentPlan.cost < bestPlan.cost) {
				bestPlan = { ...currentPlan };
			}
		});

		// Finalize IndexInfo Output
		if (bestPlan.indexId === -1) {
			// Should not happen if full scan is always an option, but handle defensively
			bestPlan.indexId = availableIndexes.findIndex(idx => idx.name === '_rowid_' || idx.name === '_primary_');
			if (bestPlan.indexId === -1) bestPlan.indexId = 0; // Default to first index (primary/rowid)
			bestPlan.planType = PLAN_TYPE_FULL_ASC;
			bestPlan.cost = tableSize * 10.0;
			bestPlan.rows = BigInt(tableSize);
			bestPlan.usedConstraintIndices.clear(); // No constraints used for default full scan
			bestPlan.orderByConsumed = false;
		}

		indexInfo.idxNum = encodeIdxNum(bestPlan.indexId, bestPlan.planType);
		indexInfo.estimatedCost = bestPlan.cost;
		indexInfo.estimatedRows = bestPlan.rows;
		indexInfo.orderByConsumed = bestPlan.orderByConsumed;
		indexInfo.idxFlags = (bestPlan.planType === PLAN_TYPE_EQ) ? 1 : 0; // SQLITE_INDEX_SCAN_UNIQUE

		// Build constraint usage
		const constraintUsage = Array.from({ length: indexInfo.nConstraint }, () => ({ argvIndex: 0, omit: false }));
		let currentArg = 1;
		bestPlan.usedConstraintIndices.forEach(constraintIndex => {
			constraintUsage[constraintIndex].argvIndex = currentArg++;
			// Omit EQ constraints if the plan is unique EQ
			constraintUsage[constraintIndex].omit = (bestPlan.planType === PLAN_TYPE_EQ);
		});
		indexInfo.aConstraintUsage = constraintUsage;

		// Construct idxStr for debugging
		const chosenIndex = availableIndexes[bestPlan.indexId];
		const idxStrParts = [
			`idx=${chosenIndex?.name ?? 'unknown'}(${bestPlan.indexId})`,
			`plan=${bestPlan.planType}`
		];
		if (bestPlan.orderByConsumed) idxStrParts.push(`ordCons=${bestPlan.isDesc ? 'DESC' : 'ASC'}`);
		if (bestPlan.usedConstraintIndices.size > 0) {
			// Create mapping from argvIndex to original constraint index
			const argvMapping = constraintUsage
				.map((usage, constraintIdx) => ({ argIdx: usage.argvIndex, constraintIdx }))
				.filter(item => item.argIdx > 0)
				.map(item => `[${item.argIdx},${item.constraintIdx}]`);
			if (argvMapping.length > 0) {
				idxStrParts.push(`argvMap=[${argvMapping.join(',')}]`);
			}
		}
		indexInfo.idxStr = idxStrParts.join(';');

		return StatusCode.OK;
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
		}
	}
}
