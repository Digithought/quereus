import { StatusCode } from '../../common/types.js';
import { SqliterError } from '../../common/errors.js';
import type { PlanNode } from '../nodes/plan-node.js';
import * as AST from '../../parser/ast.js';

// Create a javascript symbol that represents an ambiguous symbol.
export const Ambiguous = Symbol();

export type ReferenceCallback = (expression: AST.Expression, currentScope: Scope) => PlanNode;

/**
 * The Scope object provides context for symbol resolution during query planning.
 * It encapsulates the logic for looking up columns, parameters, functions, and CTEs
 * based on the current position in the PlanNode tree.
 */
export class Scope {
	/** References that have been resolved through this scope. */
	private _references: PlanNode[] = [];

	/** Symbols that have been registered in this scope. */
	private registeredSymbols: Map<string, ReferenceCallback> = new Map();

	constructor(
		/** The parent scope, if any. The root scope of a query has no parent. */
		public readonly parent?: Scope,
	) {}

	/**
	 * Registers a symbol (like a table alias, CTE name, or parameter) with a factory function
	 * that can produce a ReferenceNode for it when encountered in an expression.
	 *
	 * @param symbolKey The unique string key for this symbol in the current scope.
	 *  For tables/aliases: lower-case name.
	 *  For qualified schema.table: "schema.table" (lower-case).
	 *  For parameters: ":name" or ":index".
	 * @param getReference A factory function that takes the matching symbol and the current Scope,
	 *  and returns an appropriate ReferenceNode.
	 */
	registerSymbol(symbolKey: string, getReference: ReferenceCallback): void {
		const lowerSymbolKey = symbolKey.toLowerCase();
		if (this.registeredSymbols.has(lowerSymbolKey)) {
			throw new SqliterError(`Symbol '${lowerSymbolKey}' already exists in the same scope.`, StatusCode.ERROR);
		}
		this.registeredSymbols.set(lowerSymbolKey, getReference);
	}

	resolveSymbol(symbolKey: string, expression: AST.Expression): PlanNode | typeof Ambiguous | undefined {
		const directFactory = this.registeredSymbols.get(symbolKey.toLowerCase());
		const result = directFactory
			? directFactory(expression, this)
			: this.parent?.resolveSymbol(symbolKey, expression);
		if (result && result !== Ambiguous) {
			this.addReference(result);
		}
		return result;
	}

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

	/**
	 * Returns all symbols that have been registered in this scope.
	 *
	 * @returns An array of all [symbolKey, ReferenceCallback].
	 */
	getSymbols(): readonly [string, ReferenceCallback][] {
		return Array.from(this.registeredSymbols.entries());
	}
}

/**
 * A Scope that contains multiple other scopes.
 * Symbols are resolved in order, and the first match is used.
 * If a symbol is found in multiple scopes, an error is thrown.
 */
export class MultiScope extends Scope {
	constructor(public readonly scopes: Scope[]) {
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

/** Scope that contains no symbols. (don't add any!) */
export const EmptyScope = new Scope();
