import type { PlanNode } from "../nodes/plan-node.js";
import type { Scope } from "./scope.js";
import { Ambiguous } from "./scope.js";
import * as AST from "../../parser/ast.js";
import { BaseScope } from "./base.js";

/**
 * A Scope that aliases a parent scope.
 *
 * @param parent The parent scope, assumed to already be populated with symbols..
 */
export class AliasedScope extends BaseScope {
	private readonly _parentName: string;
	private readonly _alias: string;

	constructor(
		public readonly parent: Scope,
		parentName: string,
		alias: string
	) {
		super();
		this._parentName = parentName.toLowerCase();
		this._alias = alias.toLowerCase();
	}

	resolveSymbol(symbolKey: string, expression: AST.Expression): PlanNode | typeof Ambiguous | undefined {
		const parts = symbolKey.split('.');
		if (parts[0].toLowerCase() === this._alias) {
			parts[0] = this._parentName;
			return this.parent.resolveSymbol(parts.join('.'), expression);
		}
		return this.parent.resolveSymbol(symbolKey, expression);
	}
}