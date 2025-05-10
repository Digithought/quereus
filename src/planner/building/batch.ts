import { ResultNode } from "../nodes/result-node.js";
import * as AST from "../../parser/ast.js";
import type { Database } from "../../core/database.js";
import { MultiScope, Scope } from "../scope.js";
import { type SqlParameters, type SqlValue, SqlDataType } from "../../common/types.js";
import { ParameterReferenceNode } from "../nodes/reference-nodes.js";
import { GlobalScope } from "../global-scope.js";
import type { ScalarType } from "../../common/datatype.js";
import type { PlanNode } from "../nodes/plan-node.js";
import { buildSelectStmt } from "./select.js";

export function buildBatch(statements: AST.Statement[], db: Database, params?: SqlParameters): PlanNode[] {
	const globalScope = new GlobalScope(db.schemaManager);
	let scope: Scope = globalScope;
	if (params && params.length) {
		const paramScope = new Scope();
		if (Array.isArray(params)) {
			params.forEach((param, index) => {
				paramScope.registerSymbol(`:${index}`, (exp, s) => new ParameterReferenceNode(s, exp as AST.ParameterExpr, index, getParameterScalarType(param)));
			});
		} else {
			Object.entries(params).forEach(([key, value]) => {
				paramScope.registerSymbol(`:${key}`, (exp, s) => new ParameterReferenceNode(s, exp as AST.ParameterExpr, key, getParameterScalarType(value)));
			});
		}
		scope = new MultiScope([scope, paramScope]);
	}

	const context = { db, schemaManager: db.schemaManager, scope };

	const plans = statements.map((stmt, i) => {
		if (stmt.type === 'select') {
			const input = buildSelectStmt(stmt as AST.SelectStmt, context);
			return new ResultNode(scope, input);
		} else {
			return undefined;
		}
	})
	return plans.filter((p) => p !== undefined);
}

function getParameterScalarType(value: SqlValue): ScalarType {
  let affinity: SqlDataType;
  if (value === null) affinity = SqlDataType.NULL;
  else if (typeof value === 'number') affinity = SqlDataType.REAL;
  else if (typeof value === 'bigint') affinity = SqlDataType.INTEGER;
  else if (typeof value === 'string') affinity = SqlDataType.TEXT;
  else if (value instanceof Uint8Array) affinity = SqlDataType.BLOB;
  else if (typeof value === 'boolean') affinity = SqlDataType.INTEGER;
  else affinity = SqlDataType.BLOB;

  return {
    typeClass: 'scalar',
    affinity: affinity,
    nullable: value === null,
    isReadOnly: true,
    datatype: affinity,
  };
}
