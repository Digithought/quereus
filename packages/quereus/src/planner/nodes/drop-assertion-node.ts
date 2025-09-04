import type { Scope } from '../scopes/scope.js';
import { PlanNode, type VoidNode, type PhysicalProperties } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { VoidType } from '../../common/datatype.js';

/**
 * Represents dropping a global integrity assertion.
 * This is a DDL operation that removes an assertion from the schema.
 */
export class DropAssertionNode extends PlanNode implements VoidNode {
  override readonly nodeType = PlanNodeType.DropAssertion;

  constructor(
    scope: Scope,
    public readonly name: string,
    public readonly ifExists: boolean,
  ) {
    super(scope);
  }

  getType(): VoidType {
    return { typeClass: 'void' };
  }

  getChildren(): readonly PlanNode[] {
    return [];
  }

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    if (newChildren.length !== 0) {
      throw new Error(`DropAssertionNode expects 0 children, got ${newChildren.length}`);
    }
    return this; // No children, so no change
  }

  override toString(): string {
    return `DROP ASSERTION ${this.name}`;
  }

  override getLogicalAttributes(): Record<string, unknown> {
    return {
      name: this.name,
      ifExists: this.ifExists,
    };
  }

  override computePhysical(_children: readonly PhysicalProperties[]): Partial<PhysicalProperties> {
    return { readonly: false };
  }
}
