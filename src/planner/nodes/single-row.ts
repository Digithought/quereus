import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type ZeroAryRelationalNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import { EmptyScope } from '../scopes/empty.js';
import type { Scope } from '../scopes/scope.js';

/**
 * A dummy relational node that produces a single row with no columns.
 * Used as a source for SELECT statements without a FROM clause.
 */
export class SingleRowNode extends PlanNode implements ZeroAryRelationalNode {
  override readonly nodeType = PlanNodeType.Values; // Using Values for now, can make a dedicated type

  private static readonly singleInstance = new SingleRowNode(EmptyScope.instance); // HACK: null scope for singleton

  private readonly outputType: RelationType = {
    typeClass: 'relation',
    isReadOnly: true,
    columns: [],
    keys: [[]], // Represents a relation that can have at most one row
    rowConstraints: [],
  };

  private constructor(scope: Scope) { // Private constructor for singleton
    super(scope, 0.01); // Low cost - no IO
  }

  public static get instance(): SingleRowNode {
    return SingleRowNode.singleInstance;
  }

  getType(): RelationType {
    return this.outputType;
  }

  getChildren(): readonly [] {
    return [];
  }

	getRelations(): readonly [] {
		return [];
	}

  get estimatedRows(): number {
    return 1;
  }

  override toString(): string {
    return `${this.nodeType} (TableDee)`;
  }
}
