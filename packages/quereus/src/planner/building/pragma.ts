import type { PlanningContext } from '../planning-context.js';
import * as AST from '../../parser/ast.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue } from '../../common/types.js';
import { PragmaPlanNode } from '../nodes/pragma.js';

export function buildPragmaStmt(ctx: PlanningContext, stmt: AST.PragmaStmt): PragmaPlanNode {
	const pragmaName = stmt.name.toLowerCase();

	let value: SqlValue | undefined;
	if (stmt.value) {
		if (stmt.value.type === 'literal') {
			value = stmt.value.value;
		} else if (stmt.value.type === 'identifier') {
			value = stmt.value.name;
		} else {
			throw new QuereusError(`Unsupported PRAGMA value type: ${(stmt.value as any).type}`, StatusCode.ERROR);
		}
	}

	return new PragmaPlanNode(ctx.scope, pragmaName, stmt, value);
}
