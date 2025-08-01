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
    return this.statements;
  }

  getRelations(): readonly RelationalPlanNode[] {
    return this.statements.filter(s => s.getType().typeClass === "relation") as unknown as readonly RelationalPlanNode[];
  }

  override toString(): string {
    return `${this.statements.length} statements`;
  }

  override getLogicalAttributes(): Record<string, unknown> {
    return {
      numStatements: this.statements.length,
      statementTypes: this.statements.map(stmt => stmt.nodeType),
      parameters: Object.keys(this.parameters)
    };
  }

  get estimatedRows(): number | undefined {
    return this.getRelations().reduce((acc, s) => acc + (s.estimatedRows ?? 0), 0);
  }

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    // Check if statements changed
    if (newChildren.length !== this.statements.length) {
      // Create new instance with new statements
      return new BlockNode(
        this.scope,
        [...newChildren],
        this.parameters
      );
    }

    // Check if any individual statement changed
    const statementsChanged = newChildren.some((child, i) => child !== this.statements[i]);

    if (!statementsChanged) {
      return this;
    }

    // Create new instance with updated statements
    return new BlockNode(
      this.scope,
      [...newChildren],
      this.parameters
    );
  }
}
