import { QuereusError } from "../../common/errors.js";
import { StatusCode } from "../../common/types.js";
import type { ScalarType } from "../../common/datatype.js";
import * as AST from "../../parser/ast.js";
import type { SchemaManager } from "../../schema/manager.js";
import type { PlanNode } from "../nodes/plan-node.js";
import { TableReferenceNode, FunctionReferenceNode } from "../nodes/reference.js";
import { BaseScope } from "./base.js";
import { Ambiguous, type Scope } from "./scope.js";

export class GlobalScope extends BaseScope {
	constructor(public readonly manager: SchemaManager) {
		super();
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
