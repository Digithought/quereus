import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type UnaryRelationalNode } from './plan-node.js';
import type { BaseType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import type { SqlParameters } from '../../common/types.js';

export class BlockNode extends PlanNode {
  override readonly nodeType = PlanNodeType.Batch;

  constructor(
    scope: Scope,
    public readonly statements: PlanNode[],
		/** Snapshot of parameters utilized by the block. */
		public readonly parameters: SqlParameters
  ) {
    super(scope);
  }

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
