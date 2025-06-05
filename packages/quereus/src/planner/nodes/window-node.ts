import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type Attribute, type RelationalPlanNode, type UnaryRelationalNode, type ScalarPlanNode } from './plan-node.js';
import type { WindowFunctionCallNode } from './window-function.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import { SqlDataType } from '../../common/types.js';
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

	constructor(
		scope: Scope,
		public readonly source: RelationalPlanNode,
		public readonly windowSpec: WindowSpec,
		public readonly functions: WindowFunctionCallNode[],
		public readonly partitionExpressions: ScalarPlanNode[],
		public readonly orderByExpressions: ScalarPlanNode[],
		public readonly functionArguments: (ScalarPlanNode | null)[],
		estimatedCostOverride?: number
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
	}

	getType(): RelationType {
		return this.outputTypeCache.value;
	}

	getAttributes(): Attribute[] {
		// Preserve source attributes and add window function attributes
		const sourceAttrs = this.source.getAttributes();
		const windowAttrs = this.functions.map((func, index) => ({
			id: PlanNode.nextAttrId(),
			name: func.alias || func.functionName.toLowerCase(),
			type: func.getType(),
			sourceRelation: `${this.nodeType}:${this.id}`
		}));

		return [...sourceAttrs, ...windowAttrs];
	}

	getChildren(): readonly [] {
		return [];
	}

	getRelations(): readonly [RelationalPlanNode] {
		return [this.source];
	}

	get estimatedRows(): number | undefined {
		return this.source.estimatedRows; // Window functions don't change row count
	}

	override toString(): string {
		const partitionClause = this.windowSpec.partitionBy.length > 0
			? `PARTITION BY ${this.windowSpec.partitionBy.map(e => '...').join(', ')}`
			: '';
		const orderClause = this.windowSpec.orderBy.length > 0
			? `ORDER BY ${this.windowSpec.orderBy.map(o => '...').join(', ')}`
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
