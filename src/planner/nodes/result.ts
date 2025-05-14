import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type UnaryRelationalNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';

export class ResultNode extends PlanNode implements UnaryRelationalNode {
  override readonly nodeType = PlanNodeType.Result;

  constructor(
    scope: Scope,
    public readonly source: RelationalPlanNode,
  ) {
    super(scope);
  }

  getType(): RelationType {
    return this.source.getType();
  }

  getChildren(): readonly [] {
    return [];
  }

	getRelations(): readonly [RelationalPlanNode] {
		return [this.source];
	}

  get estimatedRows(): number | undefined {
    return this.source.estimatedRows;
  }
}
