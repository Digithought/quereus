import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type UnaryRelationalNode, type ScalarPlanNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scope.js';
import { Cached } from '../../util/cached.js';
import { expressionToString } from '../../util/ddl-stringify.js';

export type Projection = { node: ScalarPlanNode, alias?: string };

/**
 * Represents a projection operation (SELECT list) without DISTINCT.
 * It takes an input relation and outputs a new relation with specified columns/expressions.
 */
export class ProjectNode extends PlanNode implements UnaryRelationalNode {
  override readonly nodeType = PlanNodeType.Project;

  private outputTypeCache: Cached<RelationType>;

  constructor(
    scope: Scope,
    public readonly input: RelationalPlanNode,
    public readonly projections: ReadonlyArray<Projection>,
    estimatedCostOverride?: number
  ) {
    super(scope, estimatedCostOverride);

		this.outputTypeCache = new Cached(() => ({
				typeClass: 'relation',
				isReadOnly: this.input.getType().isReadOnly,
				columns: this.projections.map((proj, index) => ({
						name: proj.alias ?? expressionToString(proj.node.expression),
						type: proj.node.getType(),
						hidden: false,
						generated: proj.node.nodeType !== PlanNodeType.ColumnReference,
					})),
				// TODO: Infer keys based on DISTINCT and projection's effect on input keys
				keys: [],
				// TODO: propagate row constraints that don't have projected off columns
				rowConstraints: [],
			} as RelationType));
  }

  getType(): RelationType {
    return this.outputTypeCache.value;
  }

  getChildren(): readonly ScalarPlanNode[] {
    return this.projections.map(p => p.node);
  }

	getRelations(): readonly [RelationalPlanNode] {
		return [this.input];
	}

  get estimatedRows(): number | undefined {
    return this.input.estimatedRows; // Projection doesn't change row count - use DistinctNode to handle DISTINCT
  }

  override toString(): string {
    const projectionStrings = this.projections.map(p =>
      `${p.node.toString()}${p.alias ? ` as ${p.alias}` : ''}`
    );
    return `${this.nodeType} (${projectionStrings.join(', ')}) from (${this.input.toString()})`;
  }
}
