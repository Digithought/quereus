import { SqliteError } from '../../common/errors.js';
import { StatusCode, type SqlValue } from '../../common/types.js';
import type { Database } from '../../core/database.js';
import { columnDefToSchema, type TableSchema, buildColumnIndexMap, type IndexSchema } from '../../schema/table.js';
import { MemoryTable, type MemoryTableConfig } from './table.js';
import type { VirtualTableModule } from '../module.js';
import { MemoryTableCursor } from './cursor.js';
import { IndexConstraintOp } from '../../common/constants.js';
import type { IndexInfo } from '../indexInfo.js';

/**
 * A module that provides in-memory table functionality using digitree.
 * Tables created with this module persist only for the lifetime of the
 * database connection.
 */
export class MemoryTableModule implements VirtualTableModule<MemoryTable, MemoryTableCursor, MemoryTableConfig> {
	private static SCHEMA_VERSION = 1;
	private tables: Map<string, MemoryTable> = new Map();

	constructor() { }

	/**
	 * Creates a new memory table definition
	 */
	xCreate(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string, options: MemoryTableConfig): MemoryTable {
		// Ensure table doesn't already exist
		const tableKey = `${schemaName}.${tableName}`.toLowerCase();
		if (this.tables.has(tableKey)) {
			throw new SqliteError(`Memory table '${tableName}' already exists in schema '${schemaName}'.`, StatusCode.ERROR);
		}

		// Create the table instance
		const table = new MemoryTable(db, this, schemaName, tableName, options.readOnly ?? false);

		// Set columns and keying strategy based on options
		table.setColumns(options.columns, options.primaryKey ?? []);

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
		const tableSchema: TableSchema = Object.freeze({
			name: tableName,
			schemaName: schemaName,
			columns: finalColumnSchemas,
			columnIndexMap: buildColumnIndexMap(finalColumnSchemas),
			primaryKeyDefinition: options.primaryKey ?? [],
			checkConstraints: options.checkConstraints ?? [],
			indexes: Object.freeze(finalIndexSchemas),
			vtabModule: this,
			vtabAuxData: pAux,
			vtabArgs: [],
			vtabModuleName: moduleName,
			isWithoutRowid: false,
			isStrict: false,
			isView: false,
		});
		table.tableSchema = tableSchema;

		// Register the created table definition
		this.tables.set(tableKey, table);

		// Add secondary indexes if specified
		if (options.indexes && options.indexes.length > 0) {
			try {
				options.indexes.forEach(indexSpec => {
					table.addIndex(indexSpec);
				});
			} catch (e) {
				// Clean up partially created table if index creation fails
				this.tables.delete(tableKey);
				table.clear();
				throw new SqliteError(`Failed to create index: ${e instanceof Error ? e.message : String(e)}`, StatusCode.ERROR, e instanceof Error ? e : undefined);
			}
		}

		return table;
	}

	/**
	 * Connects to an existing memory table definition
	 */
	xConnect(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string, options: MemoryTableConfig): MemoryTable {
		const tableKey = `${schemaName}.${tableName}`.toLowerCase();
		const existingDefinition = this.tables.get(tableKey);

		if (!existingDefinition) {
			throw new SqliteError(`Memory table definition for '${tableName}' not found. Cannot connect.`, StatusCode.INTERNAL);
		}

		return existingDefinition;
	}

	/**
	 * Determines the best query plan for executing a query against a memory table
	 */
	xBestIndex(db: Database, tableInfo: TableSchema, indexInfo: IndexInfo): number {
		// Constants for planning
		const INDEX_ID_PRIMARY = 0;
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
		const pkIndexSchema: IndexSchema | null = tableInfo.primaryKeyDefinition.length > 0
			? { name: '_primary_', columns: tableInfo.primaryKeyDefinition }
			: { name: '_rowid_', columns: [{ index: -1, desc: false }] };

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
			for (let k = 0; k < indexCols.length; k++) {
				const idxCol = indexCols[k].index;
				let foundEq = false;
				for (let i = 0; i < indexInfo.nConstraint; i++) {
					const c = indexInfo.aConstraint[i];
					if (c.iColumn === idxCol && c.op === IndexConstraintOp.EQ && c.usable) {
						eqConstraintsMap.set(idxCol, i);
						eqPlanUsedIndices.add(i);
						foundEq = true;
						break;
					}
				}
				if (!foundEq) {
					canUseEqPlan = false;
					break; // Need equality on all index columns for this plan
				}
			}
			if (canUseEqPlan && indexCols.length > 0) {
				const planEqCost = Math.log2(tableSize + 1) + 1.0; // Lower cost for direct lookup
				const planEqRows = BigInt(1);
				if (planEqCost < currentPlan.cost) {
					currentPlan = {
						...currentPlan,
						planType: PLAN_TYPE_EQ,
						cost: planEqCost,
						rows: planEqRows,
						usedConstraintIndices: eqPlanUsedIndices,
						orderByConsumed: true // Equality scan implies order
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

			// 4. Update Best Plan if Current is Better
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
		let idxStrParts = [
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
		const tableDefinition = this.tables.get(tableKey);

		if (tableDefinition) {
			tableDefinition.clear();
			this.tables.delete(tableKey);
		}
	}
}
