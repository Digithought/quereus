import { VirtualTableCursor } from '../cursor.js';
import type { IndexInfo } from '../indexInfo.js';
import { StatusCode } from '../../common/types.js';
import { BTree } from 'digitree';
import { MemoryTableCursor } from './cursor.js';
import { IndexConstraintOp } from '../../common/constants.js';
import { MemoryTable, type BTreeKey, type MemoryTableRow } from './table.js';

export async function xOpenLogic(self: MemoryTable): Promise<VirtualTableCursor<MemoryTable, any>> {
	if (!self.primaryTree) {
		console.warn(`MemoryTable ${self.tableName}: primaryTree not initialized in xOpen. Re-initializing.`);
		self.primaryTree = new BTree<BTreeKey, MemoryTableRow>(self.keyFromEntry, self.compareKeys);
	}
	return new MemoryTableCursor(self);
}

export function xBestIndexLogic(self: MemoryTable, indexInfo: IndexInfo): number {
	const constraintUsage = Array.from({ length: indexInfo.nConstraint }, () => ({ argvIndex: 0, omit: false }));
	const pkIndices = self.primaryKeyColumnIndices;
	const keyIsRowid = pkIndices.length === 0;
	const tableSize = self.size || 1;

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
		const planEqCost = Math.log2(tableSize + 1) + 1.0;
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
		const planRangeCost = Math.log2(tableSize + 1) * 2.0 + Number(planRangeRows);
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
	if (indexInfo.nOrderBy === pkIndices.length && pkIndices.length > 0) {
		canConsumeOrder = pkIndices.every((pkIdx, i) => indexInfo.aOrderBy[i].iColumn === pkIdx && indexInfo.aOrderBy[i].desc === indexInfo.aOrderBy[0].desc);
		if (canConsumeOrder) isOrderDesc = indexInfo.aOrderBy[0].desc;
	} else if (indexInfo.nOrderBy === 1 && keyIsRowid && indexInfo.aOrderBy[0].iColumn === -1) {
		canConsumeOrder = true; isOrderDesc = indexInfo.aOrderBy[0].desc;
	}

	if (canConsumeOrder && (bestPlan.idxNum === PLANS.FULL_ASC || bestPlan.idxNum === PLANS.KEY_RANGE_ASC)) {
		bestPlan.orderByConsumed = true; bestPlan.isDesc = isOrderDesc;
		if (bestPlan.idxNum === PLANS.FULL_ASC) { bestPlan.idxNum = isOrderDesc ? PLANS.FULL_DESC : PLANS.FULL_ASC; }
		else { bestPlan.idxNum = isOrderDesc ? PLANS.KEY_RANGE_DESC : PLANS.KEY_RANGE_ASC; }
		bestPlan.cost *= 0.9;
	}

	indexInfo.idxNum = bestPlan.idxNum; indexInfo.estimatedCost = bestPlan.cost; indexInfo.estimatedRows = bestPlan.rows;
	indexInfo.orderByConsumed = bestPlan.orderByConsumed; indexInfo.idxFlags = (bestPlan.idxNum === PLANS.KEY_EQ) ? 1 : 0;

	let currentArg = 1;
	bestPlan.usedConstraintIndices.forEach(constraintIndex => { constraintUsage[constraintIndex].argvIndex = currentArg++; constraintUsage[constraintIndex].omit = true; });
	indexInfo.aConstraintUsage = constraintUsage;

	let idxStrParts = [`plan=${bestPlan.idxNum}`];
	if (bestPlan.orderByConsumed) idxStrParts.push(`order=${bestPlan.isDesc ? 'DESC' : 'ASC'}`);
	if (bestPlan.lowerBoundOp) idxStrParts.push(`lb_op=${bestPlan.lowerBoundOp}`);
	if (bestPlan.upperBoundOp) idxStrParts.push(`ub_op=${bestPlan.upperBoundOp}`);
	if (bestPlan.usedConstraintIndices.size > 0) idxStrParts.push(`constraints=[${[...bestPlan.usedConstraintIndices].join(',')}]`);
	indexInfo.idxStr = idxStrParts.join(',');

	return StatusCode.OK;
}

export async function xSyncLogic(self: MemoryTable): Promise<void> { } // No-op for in-memory

export async function xDisconnectLogic(self: MemoryTable): Promise<void> {
	// For this simple in-memory table, disconnect might be a no-op
	console.log(`Memory table '${self.tableName}' connection instance disconnected`);
}

export async function xDestroyLogic(self: MemoryTable): Promise<void> {
	// Access module's registry via this.module
	const module = self.module as any; // Cast needed
	if (module && typeof module.tables?.delete === 'function') {
		const tableKey = `${self.schemaName.toLowerCase()}.${self.tableName.toLowerCase()}`;
		module.tables.delete(tableKey);
	} else {
		console.warn(`Could not remove table definition ${self.tableName} from module registry during xDestroy.`);
	}
	self.clear(); // Clear data
	console.log(`Memory table '${self.tableName}' definition and data destroyed`);
}
