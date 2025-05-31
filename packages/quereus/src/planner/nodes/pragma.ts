import type { SqlValue } from '../../common/types.js';
import * as AST from '../../parser/ast.js';
import { VoidNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import { expressionToString } from '../../util/ast-stringify.js';

export class PragmaPlanNode extends VoidNode {
	override readonly nodeType = PlanNodeType.Pragma;

	constructor(
		scope: any,
		public readonly pragmaName: string,
		public readonly statementAst: AST.PragmaStmt,
		public readonly value?: SqlValue
	) {
		super(scope, 1); // PRAGMA operations have low cost
	}

	override toString(): string {
		if (this.value !== undefined) {
			return `PRAGMA ${this.pragmaName} = ${this.value}`;
		}
		return `PRAGMA ${this.pragmaName}`;
	}

	override getLogicalProperties(): Record<string, unknown> {
		const props: Record<string, unknown> = {
			pragma: this.pragmaName,
			statement: expressionToString(this.statementAst as any)
		};

		if (this.value !== undefined) {
			props.value = this.value;
		}

		return props;
	}
}
