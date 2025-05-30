import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode } from './plan-node.js';
import type { BaseType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import type { SqlParameters } from '../../common/types.js';

/**
 * Represents a block of one or more statements to be executed in sequence.
 * This is the root of most SQL query plans.
 */
export class BlockNode extends PlanNode {
  override readonly nodeType = PlanNodeType.Block;

  constructor(
    scope: Scope,
    public readonly statements: PlanNode[],
    /** Snapshot of parameters utilized by the block. */
    public readonly parameters: SqlParameters,
    estimatedCostOverride?: number
  ) {
    // Cost: sum of all statement costs
    const totalCost = statements.reduce((sum, stmt) => sum + stmt.getTotalCost(), 0);
    super(scope, estimatedCostOverride ?? totalCost);
  }

  getType(): BaseType {
    // A block doesn't have a well-defined type; it's context-dependent
    return { typeClass: 'void' };
  }

  getChildren(): readonly PlanNode[] {
    return [];
  }

  getRelations(): readonly RelationalPlanNode[] {
    return this.statements.filter(s => s.getType().typeClass === "relation") as unknown as readonly RelationalPlanNode[];
  }

  override toString(): string {
    return `${this.nodeType} (${this.statements.length} statements)`;
  }

  get estimatedRows(): number | undefined {
    return this.getRelations().reduce((acc, s) => acc + (s.estimatedRows ?? 0), 0);
  }
}
