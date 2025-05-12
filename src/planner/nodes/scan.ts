import { PlanNode, type UnaryRelationalNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { RelationType } from '../../common/datatype.js';
import { relationTypeFromTableSchema } from '../type-utils.js';
import type { Scope } from '../scopes/scope.js';
import type { TableReferenceNode } from './reference.js';

export class TableScanNode extends PlanNode implements UnaryRelationalNode {
  override readonly nodeType = PlanNodeType.TableScan;

  private readonly outputType: RelationType;

  constructor(
    scope: Scope,
    public readonly source: TableReferenceNode,
  ) {
    super(scope, 1);
    this.outputType = relationTypeFromTableSchema(source.tableSchema);
  }

  get estimatedRows(): number {
    return this.source.estimatedRows ?? 100; // Arbitrary assumption if no estimatedRows are available
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
		return [this.source];
	}

  override toString(): string {
    return `${this.nodeType} ${this.source.tableSchema.name}`;
  }
}
