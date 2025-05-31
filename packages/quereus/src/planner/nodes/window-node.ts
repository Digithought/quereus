import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type UnaryRelationalNode, type Attribute } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import type { WindowFunctionCallNode } from './window-function.js';
import type { Expression, OrderByClause } from '../../parser/ast.js';
import { expressionToString } from '../../util/ast-stringify.js';

export interface WindowSpec {
	func: WindowFunctionCallNode;
	alias: string;
}

/**
 * Represents a window operation that computes window functions over its input.
 * Window functions see the entire result set (or partition) while computing each row.
 */
export class WindowNode extends PlanNode implements UnaryRelationalNode {
	override readonly nodeType = PlanNodeType.Window;

	private outputTypeCache: Cached<RelationType>;
	private attributesCache: Cached<Attribute[]>;

	constructor(
		scope: Scope,
		public readonly source: RelationalPlanNode,
		public readonly windowSpecs: ReadonlyArray<WindowSpec>,
		public readonly partitionBy?: ReadonlyArray<Expression>,
		public readonly orderBy?: ReadonlyArray<OrderByClause>,
		estimatedCostOverride?: number
	) {
		super(scope, estimatedCostOverride);

		this.outputTypeCache = new Cached(() => {
			const sourceType = this.source.getType();
			const sourceColumns = [...sourceType.columns];

			// Window functions are added as new columns to the source columns
			const windowColumns = this.windowSpecs.map(spec => ({
				name: spec.alias,
				type: spec.func.getType(),
				generated: true,
			}));

			return {
				typeClass: 'relation',
				isReadOnly: sourceType.isReadOnly,
				isSet: sourceType.isSet,
				columns: [...sourceColumns, ...windowColumns],
				keys: sourceType.keys, // Window functions don't change keys
				rowConstraints: sourceType.rowConstraints,
			} as RelationType;
		});

		this.attributesCache = new Cached(() => {
			// Start with source attributes
			const sourceAttributes = this.source.getAttributes();
			const attributes = [...sourceAttributes];

			// Add window function attributes
			this.windowSpecs.forEach(spec => {
				attributes.push({
					id: PlanNode.nextAttrId(),
					name: spec.alias,
					type: spec.func.getType(),
					sourceRelation: `${this.nodeType}:${this.id}`
				});
			});

			return attributes;
		});
	}

	getType(): RelationType {
		return this.outputTypeCache.value;
	}

	getAttributes(): Attribute[] {
		return this.attributesCache.value;
	}

	getChildren(): readonly WindowFunctionCallNode[] {
		return this.windowSpecs.map(spec => spec.func);
	}

	getRelations(): readonly [RelationalPlanNode] {
		return [this.source];
	}

	get estimatedRows(): number | undefined {
		return this.source.estimatedRows; // Window functions don't change row count
	}

	override toString(): string {
		const windowStrings = this.windowSpecs.map(spec =>
			`${spec.func.toString()} AS ${spec.alias}`
		).join(', ');
		return `WINDOW ${windowStrings}`;
	}

	override getLogicalProperties(): Record<string, unknown> {
		const props: Record<string, unknown> = {
			windowFunctions: this.windowSpecs.map(spec => ({
				function: spec.func.toString(),
				alias: spec.alias
			}))
		};

		if (this.partitionBy?.length) {
			props.partitionBy = this.partitionBy.map(expr => expressionToString(expr));
		}

		if (this.orderBy?.length) {
			props.orderBy = this.orderBy.map(clause => ({
				expression: expressionToString(clause.expr),
				direction: clause.direction || 'asc'
			}));
		}

		return props;
	}
}
