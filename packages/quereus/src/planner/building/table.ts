import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type * as AST from '../../parser/ast.js';
import { TableReferenceNode } from '../nodes/reference.js';
import type { PlanningContext } from '../planning-context.js';
import { resolveTableSchema, resolveVtabModule } from './schema-resolution.js';

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
		throw new QuereusError('buildTableReference currently only supports simple table references.', StatusCode.INTERNAL);
	}

	// Resolve table schema at build time
	const tableSchema = resolveTableSchema(context, fromClause.table.name, fromClause.table.schema);

	// Resolve vtab module at build time
	const vtabModuleInfo = resolveVtabModule(context, tableSchema.vtabModuleName);

	return new TableReferenceNode(
		context.scope,
		tableSchema,
		vtabModuleInfo.module,
		vtabModuleInfo.auxData
	);
}

