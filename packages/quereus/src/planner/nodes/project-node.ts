import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type UnaryRelationalNode, type ScalarPlanNode, type Attribute, isRelationalNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import { projectKeys } from '../util/key-utils.js';
import { expressionToString } from '../../emit/ast-stringify.js';
import { formatProjection } from '../../util/plan-formatter.js';
import { ColumnReferenceNode } from './reference.js';
import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { ProjectionCapable } from '../framework/characteristics.js';
import type { PhysicalProperties } from './plan-node.js';
import { projectOrdering } from '../framework/physical-utils.js';

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
export class ProjectNode extends PlanNode implements UnaryRelationalNode, ProjectionCapable {
	override readonly nodeType = PlanNodeType.Project;

	private outputTypeCache: Cached<RelationType>;
	private attributesCache: Cached<readonly Attribute[]>;

	constructor(
		scope: Scope,
		public readonly source: RelationalPlanNode,
		public readonly projections: ReadonlyArray<Projection>,
		estimatedCostOverride?: number,
		/** Optional predefined attributes for preserving IDs during optimization */
		predefinedAttributes?: readonly Attribute[],
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
				keys: (() => {
					// Build source->output index map for simple column references
					const map = new Map<number, number>();
					this.projections.forEach((proj, outIdx) => {
						if (proj.node instanceof ColumnReferenceNode) {
							const colRef = proj.node as ColumnReferenceNode;
							const srcIndex = this.source.getAttributes().findIndex(a => a.id === colRef.attributeId);
							if (srcIndex >= 0) map.set(srcIndex, outIdx);
						}
					});
					return projectKeys(sourceType.keys, map);
				})(),
				// TODO: propagate row constraints that don't have projected off columns
				rowConstraints: [],
			} satisfies RelationType;
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

	computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
		const sourcePhysical = childrenPhysical[0];
		// Build mapping from source index -> projected index for ColumnReferences
		const map = new Map<number, number>();
		const sourceAttrs = this.source.getAttributes();
		this.projections.forEach((proj, outIdx) => {
			if (proj.node instanceof ColumnReferenceNode) {
				const colRef = proj.node as ColumnReferenceNode;
				const srcIndex = sourceAttrs.findIndex(a => a.id === colRef.attributeId);
				if (srcIndex >= 0 && !map.has(srcIndex)) map.set(srcIndex, outIdx);
			}
		});
		const uniqueKeys = (sourcePhysical?.uniqueKeys || [])
			.map(key => {
				const projected: number[] = [];
				for (const col of key) {
					const outIdx = map.get(col);
					if (outIdx === undefined) return null;
					projected.push(outIdx);
				}
				return projected;
			})
			.filter((k): k is number[] => k !== null);
		return {
			estimatedRows: this.source.estimatedRows,
			ordering: projectOrdering(sourcePhysical?.ordering, map),
			uniqueKeys,
		};
	}

	getType(): RelationType {
		return this.outputTypeCache.value;
	}

	getAttributes(): readonly Attribute[] {
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
			projectionCount: this.projections.length,
			uniqueKeys: this.getType().keys.map(k => k.map(ref => ref.index)),
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

	// ProjectionCapable interface implementation
	getProjections(): readonly { node: ScalarPlanNode; alias: string; attributeId: number }[] {
		const attributes = this.getAttributes();
		return this.projections.map((proj, index) => ({
			node: proj.node,
			alias: proj.alias || attributes[index].name,
			attributeId: attributes[index].id
		}));
	}

	withProjections(projections: readonly { node: ScalarPlanNode; alias: string; attributeId: number }[]): PlanNode {
		// Convert to internal Projection format
		const newProjections = projections.map(proj => ({
			node: proj.node,
			alias: proj.alias,
			attributeId: proj.attributeId
		}));

		// Check if anything changed
		const changed = newProjections.length !== this.projections.length ||
			newProjections.some((proj, i) =>
				proj.node !== this.projections[i].node ||
				proj.alias !== this.projections[i].alias ||
				proj.attributeId !== this.projections[i].attributeId
			);

		if (!changed) {
			return this;
		}

		// Create predefined attributes from the new projections
		const predefinedAttributes = projections.map(proj => ({
			id: proj.attributeId,
			name: proj.alias,
			type: proj.node.getType(),
			sourceRelation: `${this.nodeType}:${this.id}`,
			relationName: 'projection'
		}));

		return new ProjectNode(
			this.scope,
			this.source,
			newProjections,
			undefined, // estimatedCostOverride
			predefinedAttributes,
			this.preserveInputColumns
		);
	}
}
