import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import * as AST from '../../parser/ast.js';
import type { PlanNode } from '../nodes/plan-node.js';
import { type Scope, Ambiguous } from './scope.js';

/** Scope that contains no symbols.  */
export class EmptyScope implements Scope {
	resolveSymbol(_symbolKey: string, _expression: AST.Expression): PlanNode | typeof Ambiguous | undefined {
		return undefined;
	}

	getReferences(): readonly PlanNode[] {
		return [];
	}

	addReference(_reference: PlanNode): void {
		throw new QuereusError('EmptyScope does not support adding references.', StatusCode.MISUSE);
	}

	static readonly instance = new EmptyScope();
}
