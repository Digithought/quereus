import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type UnaryRelationalNode, type ScalarPlanNode, type Attribute } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import { expressionToString } from '../../util/ast-stringify.js';
import { formatProjection } from '../../util/plan-formatter.js';
import { ColumnReferenceNode } from './reference.js';

export interface Projection {
	node: ScalarPlanNode;
	alias?: string;
}

/**
 * Represents a projection operation (SELECT list) without DISTINCT.
 * It takes an input relation and outputs a new relation with specified columns/expressions.
 */
export class ProjectNode extends PlanNode implements UnaryRelationalNode {
	override readonly nodeType = PlanNodeType.Project;

	private outputTypeCache: Cached<RelationType>;
	private attributesCache: Cached<Attribute[]>;

	constructor(
		scope: Scope,
		public readonly source: RelationalPlanNode,
		public readonly projections: ReadonlyArray<Projection>,
		estimatedCostOverride?: number
	) {
		super(scope, estimatedCostOverride);

		const sourceType = this.source.getType();

		this.outputTypeCache = new Cached(() => ({
			typeClass: 'relation',
			isReadOnly: sourceType.isReadOnly,
			isSet: sourceType.isSet,
			columns: this.projections.map((proj, index) => ({
				name: proj.alias ?? expressionToString(proj.node.expression),
				type: proj.node.getType(),
				generated: proj.node.nodeType !== PlanNodeType.ColumnReference,
			})),
			// TODO: Infer keys based on DISTINCT and projection's effect on input keys
			keys: [],
			// TODO: propagate row constraints that don't have projected off columns
			rowConstraints: [],
		} as RelationType));

		this.attributesCache = new Cached(() => {
			// For each projection, preserve attribute ID if it's a simple column reference
			return this.projections.map((proj, index) => {
				// If this projection is a simple column reference, preserve its attribute ID
				if (proj.node instanceof ColumnReferenceNode) {
					return {
						id: proj.node.attributeId,
						name: proj.alias ?? proj.node.expression.name,
						type: proj.node.getType(),
						sourceRelation: `${this.nodeType}:${this.id}`
					};
				} else {
					// For computed expressions, generate new attribute ID
					return {
						id: PlanNode.nextAttrId(),
						name: proj.alias ?? expressionToString(proj.node.expression),
						type: proj.node.getType(),
						sourceRelation: `${this.nodeType}:${this.id}`
					};
				}
			});
		});
	}

	getType(): RelationType {
		return this.outputTypeCache.value;
	}

	getAttributes(): Attribute[] {
		return this.attributesCache.value;
	}

	getChildren(): readonly ScalarPlanNode[] {
		return this.projections.map(p => p.node);
	}

	getRelations(): readonly [RelationalPlanNode] {
		return [this.source];
	}

	get estimatedRows(): number | undefined {
		return this.source.estimatedRows; // Projection doesn't change row count - use DistinctNode to handle DISTINCT
	}

	override toString(): string {
		const projectionStrings = this.projections.map(p =>
			formatProjection(p.node, p.alias)
		).join(', ');
		return `SELECT ${projectionStrings}`;
	}

	override getLogicalProperties(): Record<string, unknown> {
		return {
			projections: this.projections.map(p => ({
				expression: expressionToString(p.node.expression),
				alias: p.alias
			}))
		};
	}
}
