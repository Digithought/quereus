import { Ambiguous } from "./scope";
import * as AST from "../../parser/ast.js";
import { SqliterError } from "../../common/errors";
import { StatusCode } from "../../common/types";
import type { PlanNode } from "../nodes/plan-node";
import type { Scope } from "./scope.js";
import { BaseScope } from "./base";

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
		throw new SqliterError('MultiScope does not support registering symbols.', StatusCode.ERROR);
	}

	resolveSymbol(symbolKey: string, expression: AST.Expression): PlanNode | typeof Ambiguous | undefined {
		let running: PlanNode | undefined;
		for (const scope of this.scopes) {
			const result = scope.resolveSymbol(symbolKey, expression);
			if (result === Ambiguous || (result && running)) {
				return Ambiguous;
			}
			if (result) {
				running = result;
			}
		}
		if (running) {
			this.addReference(running);
		}
		return running;
	}
}
