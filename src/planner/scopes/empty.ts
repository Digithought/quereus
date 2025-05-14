import { SqliterError } from '../../common/errors';
import { StatusCode } from '../../common/types';
import * as AST from '../../parser/ast';
import type { PlanNode } from '../nodes/plan-node';
import { type Scope, Ambiguous } from './scope';

/** Scope that contains no symbols.  */

export class EmptyScope implements Scope {
	resolveSymbol(symbolKey: string, expression: AST.Expression): PlanNode | typeof Ambiguous | undefined {
		return undefined;
	}

	getReferences(): readonly PlanNode[] {
		return [];
	}

	addReference(reference: PlanNode): void {
		throw new SqliterError('EmptyScope does not support adding references.', StatusCode.MISUSE);
	}

	static readonly instance = new EmptyScope();
}
