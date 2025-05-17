import type { IndexConstraintOp } from '../../../common/constants.js';
import type { SqlValue } from '../../../common/types.js';
import type { BTreeKey } from '../types.js';
import type { FilterInfo } from '../../filter-info.js';
import type { TableSchema } from '../../../schema/table.js';
import { IndexConstraintOp as ActualIndexConstraintOp } from '../../../common/constants.js';

/** Describes an equality constraint for a scan plan */
export interface ScanPlanEqConstraint {
	op: IndexConstraintOp.EQ;
	value: BTreeKey; // Can be composite for multi-column EQ
}

/** Describes a range bound for a scan plan */
export interface ScanPlanRangeBound {
	op: IndexConstraintOp.GT | IndexConstraintOp.GE | IndexConstraintOp.LT | IndexConstraintOp.LE;
	value: SqlValue; // Range bounds typically apply to the first column
}

/**
 * Encapsulates the details needed to execute a scan across layers.
 * Derived from IndexInfo during xBestIndex/xFilter.
 */
export interface ScanPlan {
	/** Name of the index to scan ('primary' or secondary index name) */
	indexName: string | 'primary';
	/** Scan direction */
	descending: boolean;
	/** Specific key for an equality scan (used if planType is EQ) */
	equalityKey?: BTreeKey;
	/** Lower bound for a range scan (used if planType is RANGE_*) */
	lowerBound?: ScanPlanRangeBound;
	/** Upper bound for a range scan (used if planType is RANGE_*) */
	upperBound?: ScanPlanRangeBound;
	/** The original idxNum from xBestIndex, potentially useful for cursor logic */
	idxNum?: number;
	/** The original idxStr from xBestIndex, potentially useful for debugging */
	idxStr?: string | null;

	// Additional fields might be needed for complex filtering passed down
	// e.g., remaining constraints not handled by index bounds/equality.
	// remainingConstraints?: ReadonlyArray<{ constraint: IndexConstraint, value: SqlValue }>;
}

// Helper function (moved from MemoryTableCursor and adapted)
export function buildScanPlanFromFilterInfo(filterInfo: FilterInfo, tableSchema: TableSchema): ScanPlan {
	const { idxNum, idxStr, constraints, args, indexInfoOutput } = filterInfo;
	let indexName: string | 'primary' = 'primary';
	let descending = false;
	let equalityKey: BTreeKey | undefined = undefined;
	let lowerBound: ScanPlanRangeBound | undefined = undefined;
	let upperBound: ScanPlanRangeBound | undefined = undefined;
	const params = new Map<string, string>();
	idxStr?.split(';').forEach(part => { const [key, value] = part.split('=', 2); if (key && value !== undefined) params.set(key, value); });
	const idxNameMatch = params.get('idx')?.match(/^(.*?)\\((\\d+)\\)$/);
	if (idxNameMatch) indexName = idxNameMatch[1] === '_rowid_' || idxNameMatch[1] === '_primary_' ? 'primary' : idxNameMatch[1];
	const planType = parseInt(params.get('plan') ?? '0', 10);
	descending = params.get('ordCons') === 'DESC' || planType === 1 || planType === 4;
	const argvMap = new Map<number, number>();
	params.get('argvMap')?.match(/\\[(\\d+),(\\d+)\\]/g)?.forEach(m => { const p = m.match(/\\[(\\d+),(\\d+)\\]/); if (p) argvMap.set(parseInt(p[1]), parseInt(p[2])); });
	const currentSchema = tableSchema;
	const indexSchemaForPlan = indexName === 'primary' ? { name: '_primary_', columns: currentSchema.primaryKeyDefinition ?? [{ index: -1, desc: false, collation: 'BINARY' }] } : currentSchema.indexes?.find(i => i.name === indexName);
	if (planType === 2) { // EQ Plan
		if (indexName === 'primary' && args.length === 1 && argvMap.size === 1 && currentSchema.primaryKeyDefinition.length <=1 ) equalityKey = args[0];
		else if (indexSchemaForPlan?.columns) {
			const keyParts: SqlValue[] = []; let keyComplete = true;
			for (const colSpec of indexSchemaForPlan.columns) {
				let foundArg = false;
				argvMap.forEach((constraintArrIdx, queryArgIdx) => { if (foundArg) return; const constraintInfo = indexInfoOutput.aConstraint[constraintArrIdx]; if (constraintInfo && constraintInfo.iColumn === colSpec.index && constraintInfo.op === ActualIndexConstraintOp.EQ) { keyParts.push(args[queryArgIdx - 1]); foundArg = true; } });
				if (!foundArg) { for (const cInfo of constraints) { if(foundArg) break; if (cInfo.constraint.iColumn === colSpec.index && cInfo.constraint.op === ActualIndexConstraintOp.EQ && cInfo.argvIndex > 0) { keyParts.push(args[cInfo.argvIndex - 1]); foundArg = true;}}}
				if (!foundArg) { keyComplete = false; break; }
			}
			if (keyComplete && keyParts.length > 0) equalityKey = keyParts.length === 1 && indexSchemaForPlan.columns.length === 1 ? keyParts[0] : keyParts;
		}
	} else if (planType === 3 || planType === 4) { // Range Scan
		const firstPkColDef = indexSchemaForPlan?.columns?.[0];
		if (firstPkColDef) {
			const firstColSchemaIdx = firstPkColDef.index;
			argvMap.forEach((constraintArrIdx, queryArgIdx) => { const cI = indexInfoOutput.aConstraint[constraintArrIdx]; if (cI && cI.iColumn === firstColSchemaIdx) { const v = args[queryArgIdx-1]; const op = cI.op; if (op === ActualIndexConstraintOp.GT || op === ActualIndexConstraintOp.GE) {if (!lowerBound || op > lowerBound.op) lowerBound = {value:v,op};} else if (op === ActualIndexConstraintOp.LT || op === ActualIndexConstraintOp.LE){if (!upperBound || op < upperBound.op) upperBound = {value:v,op};}}});
			constraints.forEach(cInfo => { if (cInfo.constraint.iColumn === firstColSchemaIdx && cInfo.argvIndex > 0) { const v = args[cInfo.argvIndex-1]; const op = cInfo.constraint.op; if (op===ActualIndexConstraintOp.GT || op===ActualIndexConstraintOp.GE) {if(!lowerBound || op>lowerBound.op)lowerBound={value:v,op:op};} else if (op===ActualIndexConstraintOp.LT || op===ActualIndexConstraintOp.LE){if(!upperBound||op<upperBound.op)upperBound={value:v,op:op};}}});
		}
	}
	return { indexName, descending, equalityKey, lowerBound, upperBound, idxNum, idxStr };
}
