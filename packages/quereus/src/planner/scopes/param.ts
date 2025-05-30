import type * as AST from '../../parser/ast.js';
import { ParameterReferenceNode } from '../nodes/reference.js'; // Corrected import
import { BaseScope } from './base.js';
import { Ambiguous, type Scope } from './scope.js';
import type { ScalarType } from '../../common/datatype.js';
import { SqlDataType } from '../../common/types.js';
import type { PlanNode } from '../nodes/plan-node.js';

// Default type for parameters when not otherwise specified.
const DEFAULT_PARAMETER_TYPE: ScalarType = {
	typeClass: 'scalar',
	affinity: SqlDataType.TEXT,
	nullable: true,
};

/**
 * A scope that resolves query parameters (e.g., :name, :1, ?).
 * It makes these parameters available via an accessor.
 */
export class ParameterScope extends BaseScope {
	private _nextAnonymousIndex: number = 1;
	private readonly _parameters: Map<string | number, ParameterReferenceNode> = new Map();
	private readonly _parameterTypeHints: ReadonlyMap<string | number, ScalarType>;

	constructor(
		public readonly parentScope: Scope,
		parameterTypeHints?: ReadonlyMap<string | number, ScalarType>
	) {
		super();
		this._parameterTypeHints = parameterTypeHints || new Map();
	}

	resolveSymbol(symbolKey: string, expression: AST.Expression): PlanNode | typeof Ambiguous | undefined {
		let identifier: string | number;
		let parameterNode: ParameterReferenceNode | undefined;

		// The expression should be an AST.ParameterExpr when symbolKey indicates a parameter
		const parameterExpression = expression as AST.ParameterExpr;
		let resolvedType = DEFAULT_PARAMETER_TYPE;

		if (symbolKey === '?') {
			// Use the current _nextAnonymousIndex as the potential identifier for this '?'
			const currentAnonymousId = this._nextAnonymousIndex;

			// Check if this specific anonymous parameter (by its future index) has a type hint
			if (this._parameterTypeHints.has(currentAnonymousId)) {
				resolvedType = this._parameterTypeHints.get(currentAnonymousId)!;
			}
			// Note: We don't check _parameters here for '?' because each '?' AST node should resolve,
			// potentially creating a new ParameterReferenceNode if it's a new '?' instance in the query,
			// even if it gets the same numeric index as a previous one *if* they were different AST nodes.
			// The _parameters map is more for caching resolved nodes per unique AST node or name.
			// For '?', the ParameterReferenceNode constructor expects the numeric index.
			// We use currentAnonymousId as the identifier and increment after creation.
			identifier = currentAnonymousId;
			parameterNode = new ParameterReferenceNode(this, parameterExpression, identifier, resolvedType);
			this._parameters.set(identifier, parameterNode); // Cache it by its assigned numeric ID
			this._nextAnonymousIndex++; // Increment for the *next* '?'
		} else if (symbolKey.startsWith(':')) {
			const nameOrIndex = symbolKey.substring(1);
			const numIndex = parseInt(nameOrIndex, 10);
			identifier = isNaN(numIndex) ? nameOrIndex : numIndex;

			if (this._parameters.has(identifier)) {
				parameterNode = this._parameters.get(identifier)!;
				// If already exists, its type was set at creation. Type hints are for new nodes.
			} else {
				if (this._parameterTypeHints.has(identifier)) {
					resolvedType = this._parameterTypeHints.get(identifier)!;
				}
				parameterNode = new ParameterReferenceNode(this, parameterExpression, identifier, resolvedType);
				this._parameters.set(identifier, parameterNode);
			}
		} else {
			// Not a parameter symbol, delegate to parent scope
			return this.parentScope.resolveSymbol(symbolKey, expression);
		}

		this.addReference(parameterNode!);
		return parameterNode;
	}

	/**
	 * Returns all parameters resolved by this scope.
	 */
	getParameters(): ReadonlyMap<string | number, ParameterReferenceNode> {
		return this._parameters;
	}

	/**
	 * Gets the next available anonymous parameter index (1-based) for assigning to new ' ? ' params.
	 */
	// getNextAnonymousIndex(): number { // This method might be misleading as index is auto-assigned.
	// 	return this._nextAnonymousIndex;
	// }
}
