import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type UnaryRelationalNode, type ScalarPlanNode, type Attribute, isRelationalNode } from './plan-node.js';
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
	/** Optional predefined attribute ID to preserve during optimization */
	attributeId?: number;
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
		estimatedCostOverride?: number,
		/** Optional predefined attributes for preserving IDs during optimization */
		predefinedAttributes?: Attribute[],
		/** Whether to preserve input columns in the output (default: true) */
		public readonly preserveInputColumns: boolean = true
	) {
		super(scope, estimatedCostOverride);

		const sourceType = this.source.getType();

		this.outputTypeCache = new Cached(() => {
			// Build column names with proper duplicate handling
			const columnNames: string[] = [];
			const nameCount = new Map<string, number>();

			const columns = this.projections.map((proj) => {
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
			// If predefined attributes are provided, use them (for optimization)
			if (predefinedAttributes) {
				return predefinedAttributes;
			}

			// Get the computed column names from the type
			const outputType = this.getType();

			// If preserveInputColumns is false, only create attributes for projections
			if (!this.preserveInputColumns) {
				return this.projections.map((proj, index) => ({
					id: proj.attributeId ?? PlanNode.nextAttrId(),
					name: outputType.columns[index].name,
					type: proj.node.getType(),
					sourceRelation: `${this.nodeType}:${this.id}`,
					relationName: 'projection'
				}));
			}

			// For each projection, preserve attribute ID for simple column references
			return this.projections.map((proj, index) => {
				// Use predefined attribute ID if supplied (optimizer path)
				if (proj.attributeId !== undefined) {
					return {
						id: proj.attributeId,
						name: outputType.columns[index].name,
						type: proj.node.getType(),
						sourceRelation: `${this.nodeType}:${this.id}`,
						relationName: 'projection'
					};
				}

				if (proj.node instanceof ColumnReferenceNode) {
					// Always preserve the original attribute ID so that any reference
					// to the underlying column (e.g., in ORDER BY) remains valid even
					// after aliasing. The alias is purely a name change, not a new column.
					const colRef = proj.node as ColumnReferenceNode;
					return {
						id: colRef.attributeId,
						name: outputType.columns[index].name,
						type: proj.node.getType(),
						sourceRelation: `${this.nodeType}:${this.id}`,
						relationName: 'projection'
					};
				}

				// Computed expression or aliased column – generate fresh attribute ID
				return {
					id: PlanNode.nextAttrId(),
					name: outputType.columns[index].name,
					type: proj.node.getType(),
					sourceRelation: `${this.nodeType}:${this.id}`,
					relationName: 'projection'
				};
			});
		});
	}

	getType(): RelationType {
		return this.outputTypeCache.value;
	}

	getAttributes(): Attribute[] {
		return this.attributesCache.value;
	}

	getProducingExprs(): Map<number, ScalarPlanNode> {
		const attributes = this.getAttributes();
		const map = new Map<number, ScalarPlanNode>();

		for (let i = 0; i < this.projections.length; i++) {
			const proj = this.projections[i];
			const attr = attributes[i];
			if (attr) {
				map.set(attr.id, proj.node);
			}
		}

		return map;
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

	override getLogicalAttributes(): Record<string, unknown> {
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
		if (!isRelationalNode(newSource)) {
			quereusError('ProjectNode: first child must be a RelationalPlanNode', StatusCode.INTERNAL);
		}

		// Check if anything changed
		const sourceChanged = newSource !== this.source;
		const projectionsChanged = newProjectionNodes.some((node, i) => node !== this.projections[i].node);

		if (!sourceChanged && !projectionsChanged) {
			return this;
		}

		// **CRITICAL**: Preserve original attribute IDs to maintain column reference stability
		const originalAttributes = this.getAttributes();

		// Build new projections array with preserved attribute IDs
		const newProjections = newProjectionNodes.map((node, i) => ({
			node: node as ScalarPlanNode,
			alias: this.projections[i].alias,
			attributeId: originalAttributes[i].id // Preserve original attribute ID
		}));

		// Create new instance with predefined attributes
		return new ProjectNode(
			this.scope,
			newSource as RelationalPlanNode,
			newProjections,
			undefined, // estimatedCostOverride
			originalAttributes, // Pass original attributes to preserve IDs
			this.preserveInputColumns // Preserve the flag
		);
	}
}
