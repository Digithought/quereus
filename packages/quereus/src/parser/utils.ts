import { quereusError } from '../common/errors.js';
import { SqlValue } from '../common/types.js';
import type { LiteralExpr } from './ast.js';

export function getSyncLiteral(literal: LiteralExpr): SqlValue {
	if (literal.value instanceof Promise) {
		quereusError('Literal value is a promise');
	}
	return literal.value;
}