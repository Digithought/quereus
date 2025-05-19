import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type UnaryRelationalNode } from './plan-node.js';
import type { BaseType } from '../../common/datatype.js';
import type { ParameterScope } from '../scopes/param.js';

export class BlockNode extends PlanNode {
  override readonly nodeType = PlanNodeType.Batch;

  constructor(
    scope: ParameterScope,
    public readonly statements: PlanNode[],
  ) {
    super(scope);
  }

	declare readonly scope: ParameterScope;

  getType(): BaseType {
    return { typeClass: 'list' };
  }

  getChildren(): readonly [] {
    return [];
  }

	getRelations(): readonly [RelationalPlanNode] {
		return this.statements.filter(s => s.getType().typeClass === "relation") as unknown as readonly [RelationalPlanNode];
	}

  get estimatedRows(): number | undefined {
    return this.getRelations().reduce((acc, s) => acc + (s.estimatedRows ?? 0), 0);
  }
}
