import type { SqlValue } from '../../common/types';
import * as AST from '../../parser/ast';
import { VoidNode } from './plan-node';
import { PlanNodeType } from './plan-node-type';

export class PragmaPlanNode extends VoidNode {
	readonly nodeType = PlanNodeType.Pragma;

	constructor(
		scope: any,
		public readonly pragmaName: string,
		public readonly statementAst: AST.PragmaStmt,
		public readonly value?: SqlValue
	) {
		super(scope, 1); // PRAGMA operations have low cost
	}
}
