import { PlanNode, type UnaryRelationalNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { RelationType } from '../../common/datatype.js';
import { relationTypeFromTableSchema } from '../type-utils.js';
import type { Scope } from '../scopes/scope.js';
import type { TableReferenceNode } from './reference.js';
import type { FilterInfo } from '../../vtab/filter-info.js';

export class TableScanNode extends PlanNode implements UnaryRelationalNode {
  override readonly nodeType = PlanNodeType.TableScan;

  private readonly outputType: RelationType;

  constructor(
    scope: Scope,
    public readonly source: TableReferenceNode,
    public readonly filterInfo: FilterInfo,
  ) {
    super(scope, 1);
    this.outputType = relationTypeFromTableSchema(source.tableSchema);
  }

  get estimatedRows(): number {
    return this.filterInfo.indexInfoOutput?.estimatedRows ? Number(this.filterInfo.indexInfoOutput.estimatedRows) : (this.source.estimatedRows ?? 100);
  }

	getTotalCost(): number {
		return this.filterInfo.indexInfoOutput?.estimatedCost ?? this.estimatedRows;
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
