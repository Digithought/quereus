import { SqliteError } from '../../common/errors';
import { StatusCode, type SqlValue } from '../../common/types';
import type { Database } from '../../core/database';
import { columnDefToSchema, type TableSchema, buildColumnIndexMap } from '../../schema/table';
import { MemoryTable, type MemoryTableConfig } from './table';
import type { VirtualTableModule } from '../module';
import { MemoryTableCursor } from './cursor';
import type { SqliteContext } from "../../func/context";
import type { Path } from 'digitree';
import { IndexConstraintOp } from '../../common/constants';
import { compareSqlValues } from '../../util/comparison';
import type { IndexInfo } from '../indexInfo';

/**
 * A module that provides in-memory table functionality using digitree.
 */

export class MemoryTableModule implements VirtualTableModule<MemoryTable, MemoryTableCursor, MemoryTableConfig> {
	private static SCHEMA_VERSION = 1;
	private tables: Map<string, MemoryTable> = new Map(); // Tracks created table *definitions*

	constructor() { }

	xCreate(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string, options: MemoryTableConfig): MemoryTable {
		console.log(`MemoryTableModule xCreate: Creating table definition ${schemaName}.${tableName}`);

		// Ensure table doesn't already exist in this module's registry
		const tableKey = `${schemaName}.${tableName}`.toLowerCase();
		if (this.tables.has(tableKey)) {
			throw new SqliteError(`Memory table '${tableName}' already exists in schema '${schemaName}'.`, StatusCode.ERROR);
		}

		// Create the table instance (which now primarily holds schema/config)
		const table = new MemoryTable(db, this, schemaName, tableName, options.readOnly ?? false);
		// Set columns and determine keying strategy based on options
		table.setColumns(options.columns, options.primaryKey ?? []);

		// Now, build the full ColumnSchema array for the TableSchema object.
		const finalColumnSchemas = options.columns.map((optCol, index) => columnDefToSchema({
			name: optCol.name,
			dataType: optCol.type,
			constraints: [
				...(options.primaryKey?.some(pk => pk.index === index) ? [{ type: 'primaryKey' as const }] : []),
				...(optCol.collation ? [{ type: 'collate' as const, collation: optCol.collation }] : []),
				// Add other constraints if needed
			]
		}));

		// Build and freeze the definitive TableSchema for this instance
		const tableSchema: TableSchema = Object.freeze({
			name: tableName,
			schemaName: schemaName,
			columns: finalColumnSchemas,
			columnIndexMap: buildColumnIndexMap(finalColumnSchemas),
			primaryKeyDefinition: options.primaryKey ?? [],
			checkConstraints: options.checkConstraints ?? [],
			isVirtual: true,
			vtabModule: this,
			vtabAuxData: pAux,
			vtabArgs: [], // Args handled by options
			vtabModuleName: moduleName,
			isWithoutRowid: false,
			isStrict: false,
			isView: false,
		});
		table.tableSchema = tableSchema; // Attach schema to instance

		// Register the created table definition
		this.tables.set(tableKey, table);

		return table;
	}

	xConnect(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string, options: MemoryTableConfig): MemoryTable {
		console.log(`MemoryTableModule xConnect: Connecting to table ${schemaName}.${tableName}`);
		const tableKey = `${schemaName}.${tableName}`.toLowerCase();
		const existingDefinition = this.tables.get(tableKey);

		if (!existingDefinition) {
			// This case might happen if the table was created in a previous session/connection
			// and the module instance was lost. Re-create based on options (assuming they are persisted somehow or passed again).
			// For a simple in-memory module, we might just throw an error if not found.
			throw new SqliteError(`Memory table definition for '${tableName}' not found. Cannot connect.`, StatusCode.INTERNAL);
		}

		// In this simple model, xConnect returns the same shared definition instance.
		// A more complex module might create a *new* connection-specific instance here,
		// potentially cloning state from the definition.
		return existingDefinition;
	}

	xBestIndex(db: Database, tableInfo: TableSchema, indexInfo: IndexInfo): number {
		// This logic is mostly independent of the specific connection instance
		// It relies on the static schema (tableInfo) and constraints (indexInfo)
		// We assume table size estimates are static or not needed for basic planning.

		// TODO: Currently doesn't handle sorter logic (`self.isSorter` was instance-based)
		// The concept of a table instance being a sorter needs rethinking.
		// Maybe sorters are always ephemeral tables created via OpenEphemeral?
		// For now, ignore the sorter case for module-level xBestIndex.

		const constraintUsage = Array.from({ length: indexInfo.nConstraint }, () => ({ argvIndex: 0, omit: false }));
		const pkIndices = tableInfo.primaryKeyDefinition.map(def => def.index);
		const keyIsRowid = pkIndices.length === 0;
		// Estimate table size (very basic - could be improved if module tracks size)
		const tableSize = 1000; // Placeholder estimate

		const PLANS = { FULL_ASC: 0, KEY_EQ: 1, KEY_RANGE_ASC: 2, FULL_DESC: 3, KEY_RANGE_DESC: 4 };
		let bestPlan = {
			idxNum: PLANS.FULL_ASC, cost: tableSize * 10.0, rows: BigInt(tableSize),
			usedConstraintIndices: new Set<number>(),
			boundConstraintIndices: { lower: -1, upper: -1 },
			orderByConsumed: false, isDesc: false,
			lowerBoundOp: null as IndexConstraintOp | null, upperBoundOp: null as IndexConstraintOp | null,
		};

		const eqConstraintsMap = new Map<number, number>();
		let canUseEqPlan = pkIndices.length > 0;
		for (let i = 0; i < indexInfo.nConstraint; i++) {
			const c = indexInfo.aConstraint[i];
			if (c.op === IndexConstraintOp.EQ && c.usable) {
				if (keyIsRowid && c.iColumn === -1) { eqConstraintsMap.set(-1, i); break; }
				else if (pkIndices.includes(c.iColumn)) { eqConstraintsMap.set(c.iColumn, i); }
			}
		}
		if (pkIndices.length > 0) {
			if (!pkIndices.every(pkIdx => eqConstraintsMap.has(pkIdx))) canUseEqPlan = false;
		} else {
			canUseEqPlan = eqConstraintsMap.has(-1);
		}

		if (canUseEqPlan) {
			const planEqCost = 1.0; // Log cost estimates removed for simplicity
			const planEqRows = BigInt(1);
			if (planEqCost < bestPlan.cost) {
				const usedIndices = new Set(eqConstraintsMap.values());
				bestPlan = { ...bestPlan, idxNum: PLANS.KEY_EQ, cost: planEqCost, rows: planEqRows, usedConstraintIndices: usedIndices, orderByConsumed: true };
			}
		}

		const firstPkIndex = pkIndices[0] ?? -1;
		let lowerBoundConstraint: { index: number; op: IndexConstraintOp; } | null = null;
		let upperBoundConstraint: { index: number; op: IndexConstraintOp; } | null = null;
		for (let i = 0; i < indexInfo.nConstraint; i++) {
			const c = indexInfo.aConstraint[i];
			if (c.iColumn === firstPkIndex && c.usable) {
				if (c.op === IndexConstraintOp.GT || c.op === IndexConstraintOp.GE) {
					if (!lowerBoundConstraint || (c.op > lowerBoundConstraint.op)) lowerBoundConstraint = { index: i, op: c.op };
				} else if (c.op === IndexConstraintOp.LT || c.op === IndexConstraintOp.LE) {
					if (!upperBoundConstraint || (c.op < upperBoundConstraint.op)) upperBoundConstraint = { index: i, op: c.op };
				}
			}
		}

		if (lowerBoundConstraint || upperBoundConstraint) {
			const planRangeRows = BigInt(Math.max(1, Math.floor(tableSize / 4)));
			const planRangeCost = 2.0 + Number(planRangeRows); // Simplified cost
			if (planRangeCost < bestPlan.cost) {
				const usedIndices = new Set<number>();
				if (lowerBoundConstraint) usedIndices.add(lowerBoundConstraint.index);
				if (upperBoundConstraint) usedIndices.add(upperBoundConstraint.index);
				bestPlan = {
					...bestPlan, idxNum: PLANS.KEY_RANGE_ASC, cost: planRangeCost, rows: planRangeRows,
					usedConstraintIndices: usedIndices,
					boundConstraintIndices: { lower: lowerBoundConstraint?.index ?? -1, upper: upperBoundConstraint?.index ?? -1 },
					lowerBoundOp: lowerBoundConstraint?.op ?? null, upperBoundOp: upperBoundConstraint?.op ?? null,
				};
			}
		}

		let canConsumeOrder = false;
		let isOrderDesc = false;
		if (indexInfo.nOrderBy > 0) {
			const firstOrderBy = indexInfo.aOrderBy[0];
			isOrderDesc = firstOrderBy.desc;

			if (keyIsRowid && indexInfo.nOrderBy === 1 && firstOrderBy.iColumn === -1) {
				canConsumeOrder = true;
			} else if (pkIndices.length > 0 && indexInfo.nOrderBy === pkIndices.length) {
				canConsumeOrder = pkIndices.every((pkIdx, i) =>
					indexInfo.aOrderBy[i].iColumn === pkIdx &&
					indexInfo.aOrderBy[i].desc === isOrderDesc
				);
			}
		}


		if (canConsumeOrder && (bestPlan.idxNum === PLANS.FULL_ASC || bestPlan.idxNum === PLANS.KEY_RANGE_ASC)) {
			bestPlan.orderByConsumed = true;
			bestPlan.isDesc = isOrderDesc;
			if (bestPlan.idxNum === PLANS.FULL_ASC) {
				bestPlan.idxNum = isOrderDesc ? PLANS.FULL_DESC : PLANS.FULL_ASC;
			} else { // KEY_RANGE_ASC
				bestPlan.idxNum = isOrderDesc ? PLANS.KEY_RANGE_DESC : PLANS.KEY_RANGE_ASC;
			}
			bestPlan.cost *= 0.9; // Prefer consuming order
		}

		// Fill IndexInfo output fields
		indexInfo.idxNum = bestPlan.idxNum;
		indexInfo.estimatedCost = bestPlan.cost;
		indexInfo.estimatedRows = bestPlan.rows;
		indexInfo.orderByConsumed = bestPlan.orderByConsumed;
		indexInfo.idxFlags = (bestPlan.idxNum === PLANS.KEY_EQ) ? 1 : 0; // SQLITE_INDEX_SCAN_UNIQUE

		let currentArg = 1;
		bestPlan.usedConstraintIndices.forEach(constraintIndex => {
			constraintUsage[constraintIndex].argvIndex = currentArg++;
			constraintUsage[constraintIndex].omit = true;
		});
		indexInfo.aConstraintUsage = constraintUsage;

		// Construct idxStr (optional, but helpful for debugging/xFilter)
		let idxStrParts = [`plan=${bestPlan.idxNum}`];
		if (bestPlan.orderByConsumed) idxStrParts.push(`order=${bestPlan.isDesc ? 'DESC' : 'ASC'}`);
		if (bestPlan.lowerBoundOp) idxStrParts.push(`lb_op=${bestPlan.lowerBoundOp}`);
		if (bestPlan.upperBoundOp) idxStrParts.push(`ub_op=${bestPlan.upperBoundOp}`);
		if (bestPlan.usedConstraintIndices.size > 0) idxStrParts.push(`constraints=[${[...bestPlan.usedConstraintIndices].join(',')}]`);
		indexInfo.idxStr = idxStrParts.join(',');

		return StatusCode.OK;
	}

	async xDestroy(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string): Promise<void> {
		const tableKey = `${schemaName.toLowerCase()}.${tableName.toLowerCase()}`;
		const tableDefinition = this.tables.get(tableKey);

		if (tableDefinition) {
			// Clear data associated with the definition (e.g., BTree)
			tableDefinition.clear(); // Call the instance's clear method
			this.tables.delete(tableKey);
			console.log(`Memory table definition '${tableName}' destroyed`);
		} else {
			console.warn(`Memory table definition '${tableName}' not found during xDestroy.`);
		}
		// No await needed if tableDefinition.clear() is sync
		// If clear were async, it would be: await tableDefinition.clear();
	}

}
