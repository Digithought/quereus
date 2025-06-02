import { BaseScope } from "./base.js";
import type { SchemaManager } from "../../schema/manager.js";
import type { PlanNode } from "../nodes/plan-node.js";
import * as AST from "../../parser/ast.js";
import { FunctionReferenceNode, TableReferenceNode } from "../nodes/reference.js";
import { Ambiguous } from "./scope.js";
import type { ScalarType } from "../../common/datatype.js";
import { SqlDataType } from "../../common/types.js";
import { isScalarFunctionSchema } from "../../schema/function.js";

export class GlobalScope extends BaseScope {
	constructor(public readonly manager: SchemaManager) {
		super();
	}

	resolveSymbol(symbolKey: string, expression: AST.Expression): PlanNode | typeof Ambiguous | undefined {
		if (symbolKey.includes('/')) {// Function: [schema.]name/nArgs
			const [name, nArgsStr] = symbolKey.split('/');
			const nArgs = parseInt(nArgsStr);
			const func = this.manager.findFunction(name, nArgs);
			if (!func) {
				return undefined;
			}

			// Get the proper scalar type from the function schema
			const scalarType: ScalarType = isScalarFunctionSchema(func)
				? func.returnType
				: { typeClass: 'scalar', affinity: SqlDataType.NUMERIC, nullable: true, isReadOnly: true };

			return new FunctionReferenceNode(this, func, scalarType);
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

	findUnqualifiedName(name: string): PlanNode | typeof Ambiguous | undefined {
		// Functions have priority over tables.
		// Check for zero-argument functions first
		const func = this.manager.findFunction(name, 0);
		if (func) {
			// Get the proper scalar type from the function schema
			const scalarType: ScalarType = isScalarFunctionSchema(func)
				? func.returnType
				: { typeClass: 'scalar', affinity: SqlDataType.NUMERIC, nullable: true, isReadOnly: true };

			return new FunctionReferenceNode(this, func, scalarType);
		}
		// Table: [schema.]table
		const table = this.manager.findTable(name);
		if (table) {
			// TODO: Create a proper ColumnScope to allow column references
			return new TableReferenceNode(this, table);
		}
		return undefined;
	}
}
