import type { IndexConstraintOp } from '../../../common/constants.js';
import type { SqlValue } from '../../../common/types.js';
import type { BTreeKey } from '../types.js';
import type { FilterInfo } from '../../filter-info.js';
import type { TableSchema } from '../../../schema/table.js';
import type { IndexColumnSchema, PrimaryKeyColumnDefinition } from '../../../schema/table.js';
import type { IndexConstraint, IndexInfo } from '../../index-info.js';
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
}

interface IndexSchemaLike {
	name: string;
	columns: ReadonlyArray<IndexColumnSchema | PrimaryKeyColumnDefinition>;
}

type ArgvMap = ReadonlyMap<number, number>;

function parseIdxStrParameters(idxStr: string | null): Map<string, string> {
	const params = new Map<string, string>();
	if (!idxStr) return params;

	for (const part of idxStr.split(';')) {
		const [key, value] = part.split('=', 2);
		if (key && value !== undefined) {
			params.set(key, value);
		}
	}
	return params;
}

function parseArgvMappings(raw: string | undefined): Map<number, number> {
	const mappings = new Map<number, number>();
	if (!raw) return mappings;

	const pairPattern = /\[(\d+),(\d+)\]/g;
	let match: RegExpExecArray | null;
	while ((match = pairPattern.exec(raw)) !== null) {
		const queryArgIdx = parseInt(match[1]);
		const constraintArrIdx = parseInt(match[2]);
		mappings.set(queryArgIdx, constraintArrIdx);
	}
	return mappings;
}

function resolveIndexName(idxParam: string | undefined): string | 'primary' {
	const match = idxParam?.match(/^(.*?)\((\d+)\)$/);
	if (!match) return 'primary';
	return match[1] === '_primary_' ? 'primary' : match[1];
}

function resolveIndexSchema(
	indexName: string | 'primary',
	tableSchema: TableSchema,
): IndexSchemaLike | undefined {
	if (indexName === 'primary') {
		return {
			name: '_primary_',
			columns: tableSchema.primaryKeyDefinition,
		};
	}
	return tableSchema.indexes?.find(idx => idx.name === indexName);
}

function isDescendingScan(params: Map<string, string>, planType: number): boolean {
	return params.get('ordCons') === 'DESC' || planType === 1 || planType === 4;
}

function findArgValueForColumn(
	columnIndex: number,
	argvMap: ArgvMap,
	args: ReadonlyArray<SqlValue>,
	indexInfoOutput: IndexInfo,
): SqlValue | undefined {
	for (const [queryArgIdx, constraintArrIdx] of argvMap) {
		const constraint = indexInfoOutput.aConstraint[constraintArrIdx];
		if (constraint?.iColumn === columnIndex && constraint.op === ActualIndexConstraintOp.EQ) {
			return args[queryArgIdx - 1];
		}
	}
	return undefined;
}

function findConstraintValueForColumn(
	columnIndex: number,
	constraints: ReadonlyArray<{ constraint: IndexConstraint; argvIndex: number }>,
	args: ReadonlyArray<SqlValue>,
): SqlValue | undefined {
	for (const entry of constraints) {
		if (
			entry.constraint.iColumn === columnIndex &&
			entry.constraint.op === ActualIndexConstraintOp.EQ &&
			entry.argvIndex > 0
		) {
			return args[entry.argvIndex - 1];
		}
	}
	return undefined;
}

function buildEqualityKey(
	indexName: string | 'primary',
	indexSchema: IndexSchemaLike,
	argvMap: ArgvMap,
	args: ReadonlyArray<SqlValue>,
	constraints: ReadonlyArray<{ constraint: IndexConstraint; argvIndex: number }>,
	indexInfoOutput: IndexInfo,
	tableSchema: TableSchema,
): BTreeKey | undefined {
	const isSingleColumnPrimary = indexName === 'primary'
		&& args.length === 1
		&& argvMap.size === 1
		&& tableSchema.primaryKeyDefinition.length <= 1;

	if (isSingleColumnPrimary) return args[0];

	return buildCompositeEqualityKey(indexSchema, argvMap, args, constraints, indexInfoOutput);
}

function buildCompositeEqualityKey(
	indexSchema: IndexSchemaLike,
	argvMap: ArgvMap,
	args: ReadonlyArray<SqlValue>,
	constraints: ReadonlyArray<{ constraint: IndexConstraint; argvIndex: number }>,
	indexInfoOutput: IndexInfo,
): BTreeKey | undefined {
	const keyParts: SqlValue[] = [];

	for (const colSpec of indexSchema.columns) {
		const argValue = findArgValueForColumn(colSpec.index, argvMap, args, indexInfoOutput);
		if (argValue !== undefined) {
			keyParts.push(argValue);
			continue;
		}

		const constraintValue = findConstraintValueForColumn(colSpec.index, constraints, args);
		if (constraintValue !== undefined) {
			keyParts.push(constraintValue);
			continue;
		}

		return undefined;
	}

	if (keyParts.length === 0) return undefined;
	return keyParts.length === 1 && indexSchema.columns.length === 1
		? keyParts[0]
		: keyParts;
}

function isLowerBoundOp(op: IndexConstraintOp): op is typeof ActualIndexConstraintOp.GT | typeof ActualIndexConstraintOp.GE {
	return op === ActualIndexConstraintOp.GT || op === ActualIndexConstraintOp.GE;
}

function isUpperBoundOp(op: IndexConstraintOp): op is typeof ActualIndexConstraintOp.LT | typeof ActualIndexConstraintOp.LE {
	return op === ActualIndexConstraintOp.LT || op === ActualIndexConstraintOp.LE;
}

function extractRangeBounds(
	indexSchema: IndexSchemaLike,
	argvMap: ArgvMap,
	args: ReadonlyArray<SqlValue>,
	constraints: ReadonlyArray<{ constraint: IndexConstraint; argvIndex: number }>,
	indexInfoOutput: IndexInfo,
): { lowerBound?: ScanPlanRangeBound; upperBound?: ScanPlanRangeBound } {
	const firstColumn = indexSchema.columns[0];
	if (!firstColumn) return {};

	const targetColumnIndex = firstColumn.index;
	let lowerBound: ScanPlanRangeBound | undefined;
	let upperBound: ScanPlanRangeBound | undefined;

	const applyBound = (op: IndexConstraintOp, value: SqlValue) => {
		if (isLowerBoundOp(op)) {
			if (!lowerBound || op > lowerBound.op) {
				lowerBound = { value, op };
			}
		} else if (isUpperBoundOp(op)) {
			if (!upperBound || op < upperBound.op) {
				upperBound = { value, op };
			}
		}
	};

	for (const [queryArgIdx, constraintArrIdx] of argvMap) {
		const constraint = indexInfoOutput.aConstraint[constraintArrIdx];
		if (constraint?.iColumn === targetColumnIndex) {
			applyBound(constraint.op, args[queryArgIdx - 1]);
		}
	}

	for (const entry of constraints) {
		if (entry.constraint.iColumn === targetColumnIndex && entry.argvIndex > 0) {
			applyBound(entry.constraint.op, args[entry.argvIndex - 1]);
		}
	}

	return { lowerBound, upperBound };
}

export function buildScanPlanFromFilterInfo(filterInfo: FilterInfo, tableSchema: TableSchema): ScanPlan {
	const { idxNum, idxStr, constraints, args, indexInfoOutput } = filterInfo;

	const params = parseIdxStrParameters(idxStr);
	const indexName = resolveIndexName(params.get('idx'));
	const planType = parseInt(params.get('plan') ?? '0', 10);
	const descending = isDescendingScan(params, planType);
	const argvMap = parseArgvMappings(params.get('argvMap'));
	const indexSchema = resolveIndexSchema(indexName, tableSchema);

	let equalityKey: BTreeKey | undefined;
	let lowerBound: ScanPlanRangeBound | undefined;
	let upperBound: ScanPlanRangeBound | undefined;

	const isEqPlan = planType === 2;
	const isRangePlan = planType === 3 || planType === 4;

	if (isEqPlan && indexSchema) {
		equalityKey = buildEqualityKey(
			indexName, indexSchema, argvMap, args, constraints, indexInfoOutput, tableSchema,
		);
	} else if (isRangePlan && indexSchema) {
		({ lowerBound, upperBound } = extractRangeBounds(
			indexSchema, argvMap, args, constraints, indexInfoOutput,
		));
	}

	return { indexName, descending, equalityKey, lowerBound, upperBound, idxNum, idxStr };
}
