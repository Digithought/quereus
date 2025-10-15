import type { Scope } from '../scopes/scope.js';
import { PlanNode, type RelationalPlanNode, type Attribute, type RowDescriptor, type ScalarPlanNode, isRelationalNode, isScalarNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { TableReferenceNode } from './reference.js';
import type { RelationType } from '../../common/datatype.js';
import type { RowOpFlag } from '../../schema/table.js';
import type { RowConstraintSchema } from '../../schema/table.js';

export interface ConstraintCheck {
  constraint: RowConstraintSchema;  // The constraint metadata
  expression: ScalarPlanNode;       // Pre-built expression node
  deferrable?: boolean;
  initiallyDeferred?: boolean;
  containsSubquery: boolean;        // Cached result of subquery detection
}

/**
 * Represents constraint checking for DML operations.
 * This node validates constraints against rows flowing through it.
 */
export class ConstraintCheckNode extends PlanNode implements RelationalPlanNode {
  override readonly nodeType = PlanNodeType.ConstraintCheck;

  constructor(
    scope: Scope,
    public readonly source: RelationalPlanNode,
    public readonly table: TableReferenceNode,
    public readonly operation: RowOpFlag,
    public readonly oldRowDescriptor: RowDescriptor | undefined,
    public readonly newRowDescriptor: RowDescriptor | undefined,
    public readonly flatRowDescriptor: RowDescriptor,
    public readonly constraintChecks: ConstraintCheck[],
    public readonly mutationContextValues?: Map<string, ScalarPlanNode>, // Mutation context value expressions
    public readonly contextAttributes?: Attribute[], // Mutation context attributes
    public readonly contextDescriptor?: RowDescriptor, // Mutation context row descriptor
  ) {
    super(scope);
  }

  getType(): RelationType {
    return this.source.getType();
  }

  getAttributes(): readonly Attribute[] {
    // ConstraintCheck passes through the same attributes as its source
    return this.source.getAttributes();
  }

  getRelations(): readonly [RelationalPlanNode, TableReferenceNode] {
    return [this.source, this.table];
  }

  getChildren(): readonly PlanNode[] {
    const children: PlanNode[] = [this.source];
    // Add all constraint expression nodes as children so optimizer can see them
    this.constraintChecks.forEach(check => {
      children.push(check.expression);
    });
    return children;
  }

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    const expectedChildren = 1 + this.constraintChecks.length;
    if (newChildren.length !== expectedChildren) {
      throw new Error(`ConstraintCheckNode expects ${expectedChildren} children, got ${newChildren.length}`);
    }

    const [newSource, ...newConstraintExprs] = newChildren;

    // Type check the source
    if (!isRelationalNode(newSource)) {
      throw new Error('ConstraintCheckNode: first child must be a RelationalPlanNode');
    }

    // Type check constraint expressions
    for (let i = 0; i < newConstraintExprs.length; i++) {
      const expr = newConstraintExprs[i];
      if (!isScalarNode(expr)) {
        throw new Error(`ConstraintCheckNode: constraint child ${i + 1} must be a ScalarPlanNode`);
      }
    }

    // Return same instance if nothing changed
    if (newSource === this.source &&
        newConstraintExprs.every((expr, i) => expr === this.constraintChecks[i].expression)) {
      return this;
    }

    // Rebuild constraint checks with new expressions
    const newConstraintChecks = this.constraintChecks.map((check, i) => ({
      ...check,
      expression: newConstraintExprs[i] as ScalarPlanNode
    }));

    // Create new instance
    return new ConstraintCheckNode(
      this.scope,
      newSource as RelationalPlanNode,
      this.table,
      this.operation,
      this.oldRowDescriptor,
      this.newRowDescriptor,
      this.flatRowDescriptor,
      newConstraintChecks,
      this.mutationContextValues,
      this.contextAttributes,
      this.contextDescriptor
    );
  }

  get estimatedRows(): number | undefined {
    return this.source.estimatedRows;
  }

  override toString(): string {
    const opName = this.operation === 1 ? 'INSERT' :
                   this.operation === 2 ? 'UPDATE' :
                   this.operation === 4 ? 'DELETE' : 'UNKNOWN';
    const constraintCount = this.constraintChecks.length;
    return `CHECK ${constraintCount} CONSTRAINTS ON ${opName}`;
  }

  override getLogicalAttributes(): Record<string, unknown> {
    const opName = this.operation === 1 ? 'INSERT' :
                   this.operation === 2 ? 'UPDATE' :
                   this.operation === 4 ? 'DELETE' : 'UNKNOWN';

    return {
      table: this.table.tableSchema.name,
      schema: this.table.tableSchema.schemaName,
      operation: opName,
      constraintCount: this.constraintChecks.length,
      constraintNames: this.constraintChecks.map(c => c.constraint.name || '_unnamed'),
      hasOldDescriptor: !!this.oldRowDescriptor,
      hasNewDescriptor: !!this.newRowDescriptor,
    };
  }
}
