import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { ScalarPlanNode } from '../nodes/plan-node.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('planner:validation:determinism');

/**
 * Validates that an expression is deterministic (suitable for constraints and defaults).
 * Non-deterministic expressions must be passed via mutation context instead.
 *
 * @param expr The expression plan node to validate
 * @param context Description of where the expression is used (e.g., "DEFAULT for column 'created_at'")
 * @throws QuereusError if the expression is non-deterministic
 */
export function validateDeterministicExpression(
	expr: ScalarPlanNode,
	context: string
): void {
	log('Validating determinism for: %s', context);

	// Check physical properties - this will recursively check all child nodes
	const physical = expr.physical;

	if (physical.deterministic === false) {
		log('Non-deterministic expression detected in %s: %s', context, expr.toString());

		throw new QuereusError(
			`Non-deterministic expression not allowed in ${context}. ` +
			`Expression: ${expr.toString()}. ` +
			`Use mutation context to pass non-deterministic values (e.g., WITH CONTEXT (timestamp = datetime('now'))).`,
			StatusCode.ERROR
		);
	}

	log('Expression is deterministic: %s', expr.toString());
}

/**
 * Validates that a CHECK constraint expression is deterministic.
 *
 * @param expr The constraint expression plan node
 * @param constraintName The name of the constraint (for error messages)
 * @param tableName The name of the table (for error messages)
 * @throws QuereusError if the expression is non-deterministic
 */
export function validateDeterministicConstraint(
	expr: ScalarPlanNode,
	constraintName: string,
	tableName: string
): void {
	validateDeterministicExpression(
		expr,
		`CHECK constraint '${constraintName}' on table '${tableName}'`
	);
}

/**
 * Validates that a DEFAULT expression is deterministic.
 *
 * @param expr The default value expression plan node
 * @param columnName The name of the column (for error messages)
 * @param tableName The name of the table (for error messages)
 * @throws QuereusError if the expression is non-deterministic
 */
export function validateDeterministicDefault(
	expr: ScalarPlanNode,
	columnName: string,
	tableName: string
): void {
	validateDeterministicExpression(
		expr,
		`DEFAULT for column '${columnName}' in table '${tableName}'`
	);
}

