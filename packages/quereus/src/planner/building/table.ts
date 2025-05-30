import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type * as AST from '../../parser/ast.js';
import type { TableReferenceNode } from '../nodes/reference.js';
import { TableScanNode } from '../nodes/scan.js';
import type { PlanningContext } from '../planning-context.js';
import { resolveTable } from '../resolve.js';
import { Ambiguous } from '../scopes/scope.js';
import type { IndexInfo, IndexConstraintUsage } from '../../vtab/index-info.js';
import type { FilterInfo } from '../../vtab/filter-info.js';

/**
 * Plans a table reference operation based on a FROM clause item.
 *
 * @param fromClause The AST node representing a table in the FROM clause.
 * @param context The planning context to resolve table definitions.
 * @returns A TableReferenceNode for the specified table.
 * @throws {QuereusError} If the table is not found, the reference is ambiguous, or fromClause is not a simple table.
 */
export function buildTableReference(fromClause: AST.FromClause, context: PlanningContext): TableReferenceNode {
	if (fromClause.type !== 'table') {
		throw new QuereusError('planTableScan currently only supports simple table references.', StatusCode.INTERNAL);
	}

	const tableReference = resolveTable(context.scope, fromClause.table, context.db.schemaManager.getCurrentSchemaName());
	if (!tableReference) {
		throw new QuereusError('Table not found.', StatusCode.ERROR);
	}
	if (tableReference === Ambiguous) {
		throw new QuereusError(`Ambiguous table reference (${fromClause.table.toString()}).`, StatusCode.ERROR);
	}
	if (!tableReference) {
		throw new QuereusError(`Table not found: ${fromClause.table.toString()}.`, StatusCode.ERROR);
	}
	return tableReference;
}

/**
 * Plans a table scan operation based on a FROM clause item.
 *
 * @param fromClause The AST node representing a table in the FROM clause.
 * @param context The planning context to resolve table definitions.
 * @returns A TableScanNode for the specified table.
 * @throws {QuereusError} If the table is not found, the reference is ambiguous, or fromClause is not a simple table.
 */
export function buildTableScan(fromClause: AST.FromClause, context: PlanningContext): TableScanNode {
	const tableReference = buildTableReference(fromClause, context);

	const defaultIndexInfo: IndexInfo = {
		nConstraint: 0,
		aConstraint: [],
		nOrderBy: 0,
		aOrderBy: [],
		aConstraintUsage: [] as IndexConstraintUsage[],
		idxNum: 0,
		idxStr: 'fullscan',
		orderByConsumed: false,
		estimatedCost: tableReference.estimatedRows ?? 1000,
		estimatedRows: BigInt(tableReference.estimatedRows ?? 100),
		idxFlags: 0,
		colUsed: 0n,
	};

	const filterInfo: FilterInfo = {
		idxNum: 0,
		idxStr: 'fullscan',
		constraints: [],
		args: [],
		indexInfoOutput: defaultIndexInfo,
	};

	return new TableScanNode(context.scope, tableReference, filterInfo);
}
