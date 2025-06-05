import type { Scope } from '../scopes/scope.js';
import { PlanNode, type RelationalPlanNode, type VoidNode, type Attribute } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { ScalarPlanNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';

export interface ReturningProjection {
  node: ScalarPlanNode;
  alias?: string;
}

/**
 * Represents a RETURNING clause that projects rows after a successful DML operation.
 * This node ensures that projections only execute if the underlying DML operation succeeds.
 */
export class ReturningNode extends PlanNode implements RelationalPlanNode {
  override readonly nodeType = PlanNodeType.Returning;

  constructor(
    scope: Scope,
    public readonly executor: VoidNode, // The DML operation (UpdateExecutor, etc.)
    public readonly projectionSource: RelationalPlanNode, // The source for RETURNING projections
    public readonly projections: ReadonlyArray<ReturningProjection>,
  ) {
    super(scope);
  }

  getType(): RelationType {
    // Return type is based on the projections, similar to ProjectNode
    return {
      typeClass: 'relation',
      columns: this.projections.map((proj, index) => ({
        name: proj.alias || `col_${index}`,
        type: proj.node.getType(),
        nullable: true // Conservative assumption
      })),
      isSet: this.projectionSource.getType().isSet, // Preserve set/bag semantics
      isReadOnly: false,
      keys: [], // No known keys for returning results
      rowConstraints: [], // No row constraints for returning results
    };
  }

  getAttributes(): Attribute[] {
    // Create attributes for the projected columns
    return this.projections.map((proj, index) => ({
      id: PlanNode.nextAttrId(),
      name: proj.alias || `col_${index}`,
      type: proj.node.getType(),
      sourceRelation: `${this.nodeType}:${this.id}`
    }));
  }

  getRelations(): readonly RelationalPlanNode[] {
    // Only return relational plan nodes (projectionSource), not the void executor
    return [this.projectionSource];
  }

  getVoidDependencies(): readonly VoidNode[] {
    // Return the executor VoidNode that must be executed first
    return [this.executor];
  }

  getChildren(): readonly ScalarPlanNode[] {
    return this.projections.map(proj => proj.node);
  }

  get estimatedRows(): number | undefined {
    return this.projectionSource.estimatedRows;
  }

  override toString(): string {
    const projList = this.projections.length > 3
      ? `${this.projections.length} columns`
      : this.projections.map(p => p.alias || 'expr').join(', ');
    return `RETURNING ${projList}`;
  }

  override getLogicalProperties(): Record<string, unknown> {
    return {
      executor: this.executor.nodeType,
      projectionSource: this.projectionSource.nodeType,
      projectionCount: this.projections.length,
      projections: this.projections.map(proj => ({
        alias: proj.alias,
        expression: proj.node.toString()
      }))
    };
  }
}
