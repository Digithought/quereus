import { BatchNode } from '../nodes/batch.js';
import * as AST from '../../parser/ast.js';
import type { Database } from '../../core/database.js';
import { type SqlParameters, type SqlValue, SqlDataType } from '../../common/types.js';
import { GlobalScope } from '../scopes/global.js';
import type { ScalarType } from '../../common/datatype.js';
import type { PlanNode } from '../nodes/plan-node.js';
import { buildSelectStmt } from './select.js';
import { ParameterScope } from '../scopes/param.js';

export function buildBatch(statements: AST.Statement[], db: Database, paramsInfo?: SqlParameters): BatchNode {
	const globalScope = new GlobalScope(db.schemaManager);

	let parameterTypesHint = getParameterTypeHints(paramsInfo);

  // This ParameterScope is for the entire batch. It has globalScope as its parent.
	const parameterScope = new ParameterScope(globalScope, parameterTypesHint);

    // Individual statements are planned using this batchParameterScope.
	const planningContext = { db, schemaManager: db.schemaManager, scope: parameterScope };

	const plannedStatements = statements.map((stmt) => {
		if (stmt.type === 'select') {
            // buildSelectStmt returns a BatchNode, which is a PlanNode.
			return buildSelectStmt(stmt as AST.SelectStmt, planningContext);
		} else {
			// Placeholder for other statement types
			return undefined;
		}
	}).filter(p => p !== undefined); // Ensure we only have valid PlanNodes

    // The final BatchNode for the entire batch.
    // Its scope is batchParameterScope, and it contains all successfully planned statements.
	return new BatchNode(parameterScope, plannedStatements);
}

function getParameterTypeHints(paramsInfo: SqlParameters | undefined) {
	let parameterTypesHint: Map<string | number, ScalarType> | undefined;
	if (paramsInfo) {
		parameterTypesHint = new Map<string | number, ScalarType>();
		if (Array.isArray(paramsInfo)) {
			paramsInfo.forEach((paramValue, index) => {
				// ParameterScope resolves '?' to 1-based indices internally when it sees the AST node.
				// The hints should be keyed by these 1-based indices for anonymous params.
				parameterTypesHint!.set(index + 1, getParameterScalarType(paramValue));
			});
		} else {
			Object.entries(paramsInfo).forEach(([key, value]) => {
				// For named params like ':name', ParameterScope expects 'name' as key for hints.
				parameterTypesHint!.set(key.startsWith(':') ? key.substring(1) : key, getParameterScalarType(value));
			});
		}
	}
	return parameterTypesHint;
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
