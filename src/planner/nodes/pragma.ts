import type { SqlValue } from '../../common/types.js';
import * as AST from '../../parser/ast.js';
import { VoidNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';

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
