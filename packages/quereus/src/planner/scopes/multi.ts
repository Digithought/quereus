import { Ambiguous } from "./scope.js";
import * as AST from "../../parser/ast.js";
import { QuereusError } from "../../common/errors.js";
import { StatusCode } from "../../common/types.js";
import type { PlanNode } from "../nodes/plan-node.js";
import type { Scope } from "./scope.js";
import { BaseScope } from "./base.js";

/**
 * A Scope that contains multiple other scopes.
 * Symbols are resolved in order, and the first match is used.
 * If a symbol is found in multiple scopes, an error is thrown.
 */
export class MultiScope extends BaseScope {
	constructor(
		public readonly scopes: Scope[]
	) {
		super();
	}

	registerSymbol(symbolKey: string, getReference: (expression: AST.Expression, currentScope: Scope) => PlanNode): void {
		throw new QuereusError('MultiScope does not support registering symbols.', StatusCode.ERROR);
	}

	resolveSymbol(symbolKey: string, expression: AST.Expression): PlanNode | typeof Ambiguous | undefined {
		// In SQL, inner scopes shadow outer scopes for unqualified names
		// Return the first match, don't treat multiple matches as ambiguous
		for (const scope of this.scopes) {
			const result = scope.resolveSymbol(symbolKey, expression);
			if (result === Ambiguous) {
				return Ambiguous;
			}
			if (result) {
				this.addReference(result);
				return result;
			}
		}
		return undefined;
	}
}

