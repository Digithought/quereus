import { SqliterError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type * as AST from '../../parser/ast.js';
import type { TableReferenceNode } from '../nodes/reference-nodes.js';
import { TableScanNode } from '../nodes/table-scan-node.js';
import type { PlanningContext } from '../planning-context.js';
import { resolveTable } from '../resolve.js';
import { Ambiguous } from '../scope.js';

/**
 * Plans a table reference operation based on a FROM clause item.
 *
 * @param fromClause The AST node representing a table in the FROM clause.
 * @param context The planning context to resolve table definitions.
 * @returns A TableReferenceNode for the specified table.
 * @throws {SqliterError} If the table is not found, the reference is ambiguous, or fromClause is not a simple table.
 */
export function buildTableReference(fromClause: AST.FromClause, context: PlanningContext): TableReferenceNode {
	if (fromClause.type !== 'table') {
		throw new SqliterError('planTableScan currently only supports simple table references.', StatusCode.INTERNAL);
	}

	const tableReference = resolveTable(context.scope, fromClause.table, context.db.schemaManager.getCurrentSchemaName());
	if (!tableReference) {
		throw new SqliterError('Table not found.', StatusCode.ERROR);
	}
	if (tableReference === Ambiguous) {
		throw new SqliterError(`Ambiguous table reference (${fromClause.table.toString()}).`, StatusCode.ERROR);
	}
	if (!tableReference) {
		throw new SqliterError(`Table not found: ${fromClause.table.toString()}.`, StatusCode.ERROR);
	}
	return tableReference;
}

/**
 * Plans a table scan operation based on a FROM clause item.
 *
 * @param fromClause The AST node representing a table in the FROM clause.
 * @param context The planning context to resolve table definitions.
 * @returns A TableScanNode for the specified table.
 * @throws {SqliterError} If the table is not found, the reference is ambiguous, or fromClause is not a simple table.
 */
export function buildTableScan(fromClause: AST.FromClause, context: PlanningContext): TableScanNode {
	const tableReference = buildTableReference(fromClause, context);

	return new TableScanNode(context.scope, tableReference);
}
