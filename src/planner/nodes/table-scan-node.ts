import { PlanNode, type UnaryRelationalNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { RelationType } from '../../common/datatype.js';
import { relationTypeFromTableSchema } from '../type-utils.js';
import type { Scope } from '../scope.js';
import type { TableReferenceNode } from './reference-nodes.js';

export class TableScanNode extends PlanNode implements UnaryRelationalNode {
  override readonly nodeType = PlanNodeType.TableScan;

  private readonly outputType: RelationType;

  constructor(
    scope: Scope,
    public readonly input: TableReferenceNode,
  ) {
    super(scope, 1);
    this.outputType = relationTypeFromTableSchema(input.tableSchema);
  }

  get estimatedRows(): number {
    return this.input.estimatedRows ?? 100; // Arbitrary assumption if no estimatedRows are available
  }

	getTotalCost(): number {
		return this.estimatedRows;
	}

  getType(): RelationType {
    return this.outputType;
  }

  getChildren(): readonly [] {
    return [];
  }

	getRelations(): readonly [TableReferenceNode] {
		return [this.input];
	}

  override toString(): string {
    return `${this.nodeType} ${this.input.tableSchema.name}`;
  }
}
