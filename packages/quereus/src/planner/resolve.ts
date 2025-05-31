import { Ambiguous, type Scope } from "./scopes/scope.js";
import * as AST from "../parser/ast.js";
import { ColumnReferenceNode, FunctionReferenceNode, ParameterReferenceNode, TableReferenceNode } from "./nodes/reference.js";
import { QuereusError } from "../common/errors.js";
import { StatusCode } from "../common/types.js";

export function resolveTable(scope: Scope, exp: AST.IdentifierExpr, selectedSchema: string = 'main'): TableReferenceNode | typeof Ambiguous | undefined {
	// table: [schema.]name
	const idName = exp.name;
	const idSchema = exp.schema;
	const symbolKey = idSchema ? `${idSchema}.${idName}` : `${selectedSchema}.${idName}`;

	const result = scope.resolveSymbol(symbolKey, exp);
	if (result === Ambiguous || result instanceof TableReferenceNode) {
		return result;
	}
	throw new QuereusError(`${symbolKey} isn't a table`, StatusCode.ERROR);
}

// TODO: pragma resolution
// export function resolveSchema(scope: Scope, exp: AST.IdentifierExpr): PragmaReferenceNode | typeof Ambiguous | undefined {
// 	// pragma: name
// 	const idName = exp.name.toLowerCase();
// 	const result = scope.resolveSymbol(idName);
// 	if (result === Ambiguous || result instanceof PragmaReferenceNode) {
// 		return result;
// 	}
// 	throw new QuereusError(`${idName} isn't a pragma`, StatusCode.ERROR);
// }

export function resolveColumn(scope: Scope, exp: AST.ColumnExpr, selectedSchema: string = 'main'): ColumnReferenceNode | typeof Ambiguous | undefined {
	const schemaQualifier = exp.schema;
	const tableQualifier = exp.table;
	const columnName = exp.name;

	const symbolKey = tableQualifier
		? schemaQualifier
			? `${schemaQualifier}.${tableQualifier}.${columnName}`
			: `${selectedSchema}.${tableQualifier}.${columnName}`
		: columnName;

	const result = scope.resolveSymbol(symbolKey, exp);
	if (result === Ambiguous || result instanceof ColumnReferenceNode) {
		return result;
	}
	throw new QuereusError(`${symbolKey} isn't a column`, StatusCode.ERROR);
}

export function resolveParameter(scope: Scope, exp: AST.ParameterExpr): ParameterReferenceNode | typeof Ambiguous | undefined {
	// For anonymous parameters (?), use '?' as the symbolKey
	// For named parameters (:name), use ':name' as the symbolKey
	const symbolKey = exp.name ? `:${exp.name}` : '?';
	const result = scope.resolveSymbol(symbolKey, exp);
	if (result === Ambiguous || result instanceof ParameterReferenceNode) {
		return result;
	}
	throw new QuereusError(`${symbolKey} isn't a parameter`, StatusCode.ERROR);
}

export function resolveFunction(scope: Scope, exp: AST.FunctionExpr): FunctionReferenceNode | typeof Ambiguous | undefined {
	// First try exact argument count
	const symbolKey = exp.name.toLowerCase() + '/' + exp.args.length;
	let result = scope.resolveSymbol(symbolKey, exp);
	if (result === Ambiguous || result instanceof FunctionReferenceNode) {
		return result;
	}

	// If exact match not found, try variable argument function (numArgs = -1)
	const varArgSymbolKey = exp.name.toLowerCase() + '/-1';
	result = scope.resolveSymbol(varArgSymbolKey, exp);
	if (result === Ambiguous || result instanceof FunctionReferenceNode) {
		return result;
	}

	throw new QuereusError(`Function not found/ambiguous: ${exp.name}/${exp.args.length}`, StatusCode.ERROR);
}
