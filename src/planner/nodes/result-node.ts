import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type UnaryRelationalNode } from './plan-node.js';
import type { RelationType, ScalarType } from '../../common/datatype.js';
import { Scope } from '../scope.js';
import { type SqlParameters, type SqlValue, SqlDataType } from '../../common/types.js';

export class ResultNode extends PlanNode implements UnaryRelationalNode {
  override readonly nodeType = PlanNodeType.Result;

  constructor(
    scope: Scope,
    public readonly input: RelationalPlanNode,
  ) {
    super(scope);
  }

  getType(): RelationType {
    return this.input.getType();
  }

  getChildren(): readonly [] {
    return [];
  }

	getRelations(): readonly [RelationalPlanNode] {
		return [this.input];
	}

  get estimatedRows(): number | undefined {
    return this.input.estimatedRows;
  }
}
