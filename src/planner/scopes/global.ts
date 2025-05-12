import { SqliterError } from "../common/errors.js";
import { StatusCode } from "../common/types.js";
import type { SchemaManager } from "../schema/manager.js";
import { Ambiguous, Scope } from "./scope.js";
import type { PlanNode } from "./nodes/plan-node";
import { FunctionReferenceNode, TableReferenceNode } from "./nodes/reference-nodes.js";
import type { ScalarType } from "../common/datatype.js";
import * as AST from "../parser/ast.js";

export class GlobalScope extends Scope {
	constructor(public readonly manager: SchemaManager) {
		super();
	}

	registerSymbol(symbolKey: string, getReference: (expression: AST.Expression, currentScope: Scope) => PlanNode): void {
		throw new SqliterError('GlobalScope does not support registering symbols.', StatusCode.ERROR);
	}

	resolveSymbol(symbolKey: string, expression: AST.Expression): PlanNode | typeof Ambiguous | undefined {
		if (symbolKey.endsWith(')')) {// Function: [schema.]name(nArgs)
			const [name, nArgs] = symbolKey.split('(');
			const func = this.manager.findFunction(name, parseInt(nArgs.substring(1, nArgs.length - 1)));
			if (!func) {
				return undefined;
			}
			// TODO: Need a way to determine function type from schema
			return new FunctionReferenceNode(this, func, { typeClass: 'scalar', affinity: func.affinity, nullable: true } as ScalarType);
		}
		// Table: [schema.]table
		const [first, second] = symbolKey.split('.');
		const schema = second ? first : undefined;
		const table = second ? second : first;
		const tableSchema = this.manager.findTable(table, schema);
		if (!tableSchema) {
			return undefined;
		}
		return new TableReferenceNode(this, tableSchema);
	}

}
