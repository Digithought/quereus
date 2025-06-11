import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type UnaryRelationalNode, type ScalarPlanNode, type Attribute } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import { expressionToString } from '../../util/ast-stringify.js';
import { formatProjection } from '../../util/plan-formatter.js';
import { ColumnReferenceNode } from './reference.js';
import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

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

		this.outputTypeCache = new Cached(() => {
			// Build column names with proper duplicate handling
			const columnNames: string[] = [];
			const nameCount = new Map<string, number>();

			const columns = this.projections.map((proj, index) => {
				// Determine base column name
				let baseName: string;
				if (proj.alias) {
					baseName = proj.alias;
				} else if (proj.node instanceof ColumnReferenceNode) {
					// For column references, use the unqualified column name
					baseName = proj.node.expression.name;
				} else {
					// For expressions, use the string representation
					baseName = expressionToString(proj.node.expression);
				}

				// Handle duplicate names
				let finalName: string;
				const currentCount = nameCount.get(baseName) || 0;
				if (currentCount === 0) {
					// First occurrence - use the base name
					finalName = baseName;
				} else {
					// Subsequent occurrences - add numbered suffix
					finalName = `${baseName}:${currentCount}`;
				}
				nameCount.set(baseName, currentCount + 1);
				columnNames.push(finalName);

				return {
					name: finalName,
					type: proj.node.getType(),
					generated: proj.node.nodeType !== PlanNodeType.ColumnReference,
				};
			});

			return {
				typeClass: 'relation',
				isReadOnly: sourceType.isReadOnly,
				isSet: sourceType.isSet,
				columns,
				// TODO: Infer keys based on DISTINCT and projection's effect on input keys
				keys: [],
				// TODO: propagate row constraints that don't have projected off columns
				rowConstraints: [],
			} as RelationType;
		});

		this.attributesCache = new Cached(() => {
			// Get the computed column names from the type
			const outputType = this.getType();

			// For each projection, preserve attribute ID if it's a simple column reference
			return this.projections.map((proj, index) => {
				// If this projection is a simple column reference, preserve its attribute ID
				if (proj.node instanceof ColumnReferenceNode) {
					return {
						id: proj.node.attributeId,
						name: outputType.columns[index].name, // Use the deduplicated name
						type: proj.node.getType(),
						sourceRelation: `${this.nodeType}:${this.id}`
					};
				} else {
					// For computed expressions, generate new attribute ID
					return {
						id: PlanNode.nextAttrId(),
						name: outputType.columns[index].name, // Use the deduplicated name
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

	getChildren(): readonly PlanNode[] {
		return [this.source, ...this.projections.map(p => p.node)];
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

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 1 + this.projections.length) {
			quereusError(`ProjectNode expects ${1 + this.projections.length} children, got ${newChildren.length}`, StatusCode.INTERNAL);
		}

		const [newSource, ...newProjectionNodes] = newChildren;

		// Type check
		if (!('getAttributes' in newSource) || typeof (newSource as any).getAttributes !== 'function') {
			quereusError('ProjectNode: first child must be a RelationalPlanNode', StatusCode.INTERNAL);
		}

		// Check if anything changed
		const sourceChanged = newSource !== this.source;
		const projectionsChanged = newProjectionNodes.some((node, i) => node !== this.projections[i].node);

		if (!sourceChanged && !projectionsChanged) {
			return this;
		}

		// Build new projections array
		const newProjections = newProjectionNodes.map((node, i) => ({
			node: node as ScalarPlanNode,
			alias: this.projections[i].alias
		}));

		// Create new instance - ProjectNode creates new attributes for expressions
		return new ProjectNode(
			this.scope,
			newSource as RelationalPlanNode,
			newProjections
		);
	}
}
