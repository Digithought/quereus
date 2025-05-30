import type { PlanNode } from '../nodes/plan-node.js';
import * as AST from '../../parser/ast.js';
import { type Scope, Ambiguous } from './scope.js';

/**
 * Scope that tracks references.
 */
export abstract class BaseScope implements Scope {
	/** References that have been resolved through this scope. */
	private _references: PlanNode[] = [];

	abstract resolveSymbol(symbolKey: string, expression: AST.Expression): PlanNode | typeof Ambiguous | undefined;

	/**
	 * Returns all references that have been resolved through this scope.
	 * This includes references from both this scope and any parent scopes.
	 *
	 * @returns An array of all resolved references.
	 */
	getReferences(): readonly PlanNode[] {
		return this._references;
	}

	addReference(reference: PlanNode): void {
		this._references.push(reference);
	}
}
