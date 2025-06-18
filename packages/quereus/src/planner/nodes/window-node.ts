import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type Attribute, type RelationalPlanNode, type UnaryRelationalNode, type ScalarPlanNode } from './plan-node.js';
import type { WindowFunctionCallNode } from './window-function.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import type * as AST from '../../parser/ast.js';

export interface WindowSpec {
	partitionBy: AST.Expression[];
	orderBy: AST.OrderByClause[];
	frame?: AST.WindowFrame;
}

/**
 * Represents a window operation that computes window functions over partitions of rows.
 * This node groups window functions that share the same window specification for efficiency.
 */
export class WindowNode extends PlanNode implements UnaryRelationalNode {
	override readonly nodeType = PlanNodeType.Window;

	private outputTypeCache: Cached<RelationType>;
	private attributesCache: Cached<Attribute[]>;

	constructor(
		scope: Scope,
		public readonly source: RelationalPlanNode,
		public readonly windowSpec: WindowSpec,
		public readonly functions: WindowFunctionCallNode[],
		public readonly partitionExpressions: ScalarPlanNode[],
		public readonly orderByExpressions: ScalarPlanNode[],
		public readonly functionArguments: (ScalarPlanNode | null)[],
		estimatedCostOverride?: number,
		/** Optional predefined attributes for preserving IDs during optimization */
		public readonly predefinedAttributes?: Attribute[]
	) {
		super(scope, estimatedCostOverride);

		this.outputTypeCache = new Cached(() => {
			const sourceType = this.source.getType();

			// Add window function columns to the source columns
			const windowColumns = this.functions.map(func => ({
				name: func.alias || func.functionName.toLowerCase(),
				type: func.getType(),
				generated: true
			}));

			return {
				typeClass: 'relation',
				isReadOnly: sourceType.isReadOnly,
				isSet: sourceType.isSet, // Window functions preserve set/bag semantics
				columns: [...sourceType.columns, ...windowColumns],
				keys: sourceType.keys, // Window functions don't change key structure
				rowConstraints: sourceType.rowConstraints,
			} as RelationType;
		});

		this.attributesCache = new Cached(() => {
			// If predefined attributes are provided, use them (for optimization)
			if (this.predefinedAttributes) {
				return this.predefinedAttributes.slice(); // Return a copy
			}

			// Preserve source attributes and add window function attributes
			const sourceAttrs = this.source.getAttributes();
			const windowAttrs = this.functions.map((func) => ({
				id: PlanNode.nextAttrId(),
				name: func.alias || func.functionName.toLowerCase(),
				type: func.getType(),
				sourceRelation: `${this.nodeType}:${this.id}`
			}));

			return [...sourceAttrs, ...windowAttrs];
		});
	}

	getType(): RelationType {
		return this.outputTypeCache.value;
	}

	getAttributes(): Attribute[] {
		return this.attributesCache.value;
	}

	getChildren(): readonly PlanNode[] {
		// Return all scalar expressions: partition expressions, order by expressions, and function arguments
		const children: PlanNode[] = [];
		children.push(...this.partitionExpressions);
		children.push(...this.orderByExpressions);
		children.push(...this.functionArguments.filter(arg => arg !== null) as ScalarPlanNode[]);
		return children;
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		const expectedLength = this.partitionExpressions.length +
			this.orderByExpressions.length +
			this.functionArguments.filter(arg => arg !== null).length;

		if (newChildren.length !== expectedLength) {
			throw new Error(`WindowNode expects ${expectedLength} children, got ${newChildren.length}`);
		}

		// Type check
		for (const child of newChildren) {
			if (!('expression' in child)) {
				throw new Error('WindowNode: all children must be ScalarPlanNodes');
			}
		}

		// Split children back into their respective arrays
		let childIndex = 0;
		const newPartitionExpressions = newChildren.slice(childIndex, childIndex + this.partitionExpressions.length) as ScalarPlanNode[];
		childIndex += this.partitionExpressions.length;

		const newOrderByExpressions = newChildren.slice(childIndex, childIndex + this.orderByExpressions.length) as ScalarPlanNode[];
		childIndex += this.orderByExpressions.length;

		const newNonNullFunctionArgs = newChildren.slice(childIndex) as ScalarPlanNode[];

		// Rebuild function arguments array preserving null positions
		const newFunctionArguments: (ScalarPlanNode | null)[] = [];
		let nonNullIndex = 0;
		for (const arg of this.functionArguments) {
			if (arg === null) {
				newFunctionArguments.push(null);
			} else {
				newFunctionArguments.push(newNonNullFunctionArgs[nonNullIndex++]);
			}
		}

		// Check if anything changed
		const partitionChanged = newPartitionExpressions.some((expr, i) => expr !== this.partitionExpressions[i]);
		const orderByChanged = newOrderByExpressions.some((expr, i) => expr !== this.orderByExpressions[i]);
		const functionArgsChanged = newFunctionArguments.some((arg, i) => arg !== this.functionArguments[i]);

		if (!partitionChanged && !orderByChanged && !functionArgsChanged) {
			return this;
		}

		// **CRITICAL**: Preserve original attribute IDs to maintain column reference stability
		const originalAttributes = this.getAttributes();

		// Create new instance with preserved attributes
		return new WindowNode(
			this.scope,
			this.source, // Source doesn't change via withChildren
			this.windowSpec,
			this.functions, // Functions don't change via withChildren
			newPartitionExpressions,
			newOrderByExpressions,
			newFunctionArguments,
			undefined, // estimatedCostOverride
			originalAttributes // Preserve original attribute IDs
		);
	}

	getRelations(): readonly [RelationalPlanNode] {
		return [this.source];
	}

	get estimatedRows(): number | undefined {
		return this.source.estimatedRows; // Window functions don't change row count
	}

	override toString(): string {
		const partitionClause = this.windowSpec.partitionBy.length > 0
			? `PARTITION BY ${this.windowSpec.partitionBy.map(_e => '...').join(', ')}`
			: '';
		const orderClause = this.windowSpec.orderBy.length > 0
			? `ORDER BY ${this.windowSpec.orderBy.map(_o => '...').join(', ')}`
			: '';
		const clauses = [partitionClause, orderClause].filter(c => c).join(' ');
		const funcNames = this.functions.map(f => f.functionName).join(', ');

		return `WINDOW ${funcNames} OVER (${clauses})`;
	}

	override getLogicalProperties(): Record<string, unknown> {
		return {
			windowSpec: {
				partitionBy: this.windowSpec.partitionBy.length,
				orderBy: this.windowSpec.orderBy.length,
				frame: this.windowSpec.frame ? 'custom' : 'default'
			},
			functions: this.functions.map(f => ({
				name: f.functionName,
				alias: f.alias,
				distinct: f.isDistinct
			}))
		};
	}
}
