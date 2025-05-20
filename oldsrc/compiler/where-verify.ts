import { createLogger } from '../common/logger.js';
import { IndexConstraintOp } from '../common/constants.js';
import { Opcode } from '../vdbe/opcodes.js';
import type { Compiler } from './compiler.js';
import type { CursorPlanningResult } from './structs.js';
import type * as AST from '../parser/ast.js';
import type { TableSchema } from '../schema/table.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import { analyzeSubqueryCorrelation } from './correlation.js';
import { expressionToString } from '../util/ddl-stringify.js';
import type { PlannedStep } from './planner/types.js';
import type { IndexConstraintUsage } from '../vtab/indexInfo.js';

const log = createLogger('compiler:where-verify');
const warnLog = log.extend('warn');
const errorLog = log.extend('error');

/**
 * Map from IndexConstraintOp codes back to AST binary operators.
 * Used for reconstructing verification expressions.
 */
const inverseConstraintOpMap: { [key in IndexConstraintOp]?: { op: string, swap?: boolean } } = Object.freeze({
	[IndexConstraintOp.EQ]: { op: '=' },
	[IndexConstraintOp.LT]: { op: '<' },
	[IndexConstraintOp.LE]: { op: '<=' },
	[IndexConstraintOp.GT]: { op: '>' },
	[IndexConstraintOp.GE]: { op: '>=' },
	[IndexConstraintOp.NE]: { op: '!=' },
	[IndexConstraintOp.IS]: { op: 'IS' },
	[IndexConstraintOp.ISNOT]: { op: 'IS NOT' },
	[IndexConstraintOp.LIKE]: { op: 'LIKE' },
	[IndexConstraintOp.GLOB]: { op: 'GLOB' },
	[IndexConstraintOp.REGEXP]: { op: 'REGEXP' },
	[IndexConstraintOp.MATCH]: { op: 'MATCH' }, // Note: MATCH verification might be complex
});

/**
 * Emits VDBE code to verify constraints from a specific plan (e.g., innerLoopPlan)
 * that were used by the plan but not marked as 'omit'.
 * This is crucial for joins where the inner VFilter might receive constraints involving
 * outer cursors, and the VTab might return rows that don't strictly match.
 *
 * @param compiler The compiler instance
 * @param plan The CursorPlanningResult to verify constraints for
 * @param tableSchema The schema of the table the plan applies to
 * @param cursorIdx The cursor index the plan applies to
 * @param jumpTargetIfFalse Address ID to jump to if verification fails
 * @param activeOuterCursors Set of cursor IDs active *outside* the cursor being verified (needed for compiling value expressions)
 */
export function verifyPlannedConstraints(
	compiler: Compiler,
	plan: Readonly<CursorPlanningResult>,
	tableSchema: Readonly<TableSchema>,
	cursorIdx: number,
	jumpTargetIfFalse: number,
	activeOuterCursors: ReadonlySet<number>
): void {
	if (plan.constraints.length === 0 || (plan.usage && plan.usage.every((u: IndexConstraintUsage) => u.argvIndex === 0 || u.omit))) {
		// No verifiable constraints used by this plan or usage is missing (should not happen for valid plans)
		if (!plan.usage && plan.constraints.length > 0) {
			warnLog(`verifyPlannedConstraints: plan for cursor ${cursorIdx} has constraints but no usage. Skipping verification.`);
		}
		return;
	}
	log(`Verifying constraints for cursor ${cursorIdx} (plan idxNum=${plan.idxNum}), jump target ${jumpTargetIfFalse}`);

	const tempReg = compiler.allocateMemoryCells(1);

	for (let i = 0; i < plan.constraints.length; i++) {
		const constraint = plan.constraints[i];
		const usage = plan.usage[i]; // Assuming constraints and usage are parallel arrays

		// Verify if the constraint was used (argvIndex > 0) AND not guaranteed by the VTab (omit = false)
		if (usage && usage.argvIndex > 0 && !usage.omit) { // Add null check for usage
			const originalValueExpr = plan.constraintExpressions.get(i);
			let verificationExpr: AST.Expression | null = null;
			let verificationExprLoc: AST.AstNode['loc'] | undefined = originalValueExpr?.loc;

			// Get the column expression on the table being verified
			let columnSideExpr: AST.Expression;
			if (constraint.iColumn === -1) {
				// Rowid case
				columnSideExpr = { type: 'column', name: 'rowid', table: tableSchema.name }; // Assuming rowid access like this works
				log(`  Verifying rowid constraint ${i} (op ${constraint.op})`);
			} else {
				const colName = tableSchema.columns[constraint.iColumn]?.name;
				if (!colName) {
					errorLog(`Cannot find column name for index ${constraint.iColumn} in table ${tableSchema.name} during constraint verification.`);
					continue; // Skip verification for this constraint
				}
				columnSideExpr = { type: 'column', name: colName, table: tableSchema.name };
				log(`  Verifying constraint ${i} on ${tableSchema.name}.${colName} (op ${constraint.op})`);
			}

			// Reconstruct the verification expression based on the constraint type
			if (constraint.op === IndexConstraintOp.ISNULL || constraint.op === IndexConstraintOp.ISNOTNULL) {
				// Reconstruct unary IS NULL / IS NOT NULL
				if (originalValueExpr?.type === 'unary') {
					verificationExpr = { ...originalValueExpr, expr: columnSideExpr };
					verificationExprLoc = originalValueExpr.loc;
				} else {
					// Should not happen if planner extracted ISNULL/ISNOTNULL correctly
					warnLog(`Cannot reconstruct IS NULL/IS NOT NULL verification expression for constraint ${i}. Original expr type: ${originalValueExpr?.type}`);
					continue;
				}
			} else {
				// Reconstruct binary expressions (EQ, LT, GT, LIKE, etc.)
				if (!originalValueExpr) {
					errorLog(`Could not find original value expression for constraint verification (cursor ${cursorIdx}, constraint ${i}, op ${constraint.op})`);
					continue; // Skip verification
				}
				const opInfo = inverseConstraintOpMap[constraint.op];
				if (!opInfo) {
					warnLog(`Cannot map constraint op ${constraint.op} back to AST operator for verification.`);
					continue; // Skip verification
				}

				// Create the binary expression: (Column OP Value)
				// Value expression needs to be compiled in the context of the *outer* cursors
				const binaryExpr: AST.BinaryExpr = { type: 'binary', operator: opInfo.op, left: columnSideExpr, right: originalValueExpr, loc: verificationExprLoc };
				verificationExpr = binaryExpr;
			}

			// Compile and emit the check
			if (verificationExpr) {
				// The set of all cursors needed for this expression includes both the inner cursor and outer cursors
				const allCursorsForExpr = new Set([...activeOuterCursors, cursorIdx]);
				const correlation = analyzeSubqueryCorrelation(compiler, verificationExpr, allCursorsForExpr);

				log(`    Compiling verification expr: ${expressionToString(verificationExpr)}`);
				compiler.compileExpression(verificationExpr, tempReg, correlation);

				const opStr = (verificationExpr.type === 'unary' ? verificationExpr.operator : (verificationExpr.type === 'binary' ? verificationExpr.operator : `op${constraint.op}`));

				// Emit the jump IF FALSE. If true, continue verification or processing.
				compiler.emit(Opcode.IfFalse, tempReg, jumpTargetIfFalse, 0, null, 0, `Verify JOIN constraint ${i} (${opStr})`);
			}
		}
	}
}

/**
 * Emits VDBE code to verify constraints that were used by the plan but not marked as 'omit'.
 * This prevents incorrect results if xFilter returns rows that don't strictly match the original WHERE clause.
 * (Used for simple WHERE clauses on a single table scan).
 *
 * @param compiler The compiler instance
 * @param cursorIdx The cursor index to verify constraints for
 * @param jumpTargetIfFalse Address to jump to if verification fails
 * @deprecated Prefer verifyPlannedConstraints for clarity, though functionality is similar for base scans.
 */
export function verifyWhereConstraintsHelper(
	compiler: Compiler,
	cursorIdx: number,
	jumpTargetIfFalse: number
): void {
	const planningInfo = compiler.cursorPlanningInfo.get(cursorIdx);
	if (!planningInfo) {
		warnLog(`No planning info found for cursor ${cursorIdx} in verifyWhereConstraintsHelper.`);
		return;
	}
	const tableSchema = compiler.tableSchemas.get(cursorIdx);
	if (!tableSchema) {
		throw new QuereusError(`Internal: Schema missing for cursor ${cursorIdx} during helper verification`, StatusCode.INTERNAL);
	}

	// For a base table scan, there are no "outer" cursors relative to the constraints being checked.
	verifyPlannedConstraints(compiler, planningInfo, tableSchema, cursorIdx, jumpTargetIfFalse, new Set());
}

// --- WHERE Clause Verification and Unhandled Compilation --- //

/**
 * Compiles only the parts of a WHERE expression that were not handled by
 * the query plan (xBestIndex or verifyWhereConstraintsHelper).
 *
 * @param compiler The compiler instance
 * @param expr The WHERE expression to compile
 * @param activeCursors Cursors active in the current loop level
 * @param jumpTargetIfFalse Address to jump to if the condition is false
 * @param currentStep The planned step that produced the current row being evaluated (optional)
 */
export function compileUnhandledWhereConditions(
	compiler: Compiler,
	expr: AST.Expression | undefined,
	activeCursors: number[],
	jumpTargetIfFalse: number,
	currentStep: PlannedStep | null = null
): void {
	if (!expr) {
		return;
	}

	// Collect nodes handled by index scans
	const handledByScan = new Set<AST.Expression>();
	activeCursors.forEach(cursorIdx => {
		compiler.cursorPlanningInfo.get(cursorIdx)?.handledWhereNodes.forEach(node => {
			handledByScan.add(node);
		});
	});

	// Collect string representations of predicates handled by join pushdown
	const handledByJoinPushdown = new Set<string>();
	if (currentStep?.type === 'Join' && currentStep.handledPredicates) {
		currentStep.handledPredicates.forEach(pred => {
			handledByJoinPushdown.add(expressionToString(pred));
		});
	}

	const compileRecursive = (node: AST.Expression) => {
		// Check if handled by index scan
		if (handledByScan.has(node)) {
			log(`Skipping WHERE node handled by index scan: ${expressionToString(node)}`);
			return;
		}

		// Check if handled by join pushdown (using string comparison)
		if (handledByJoinPushdown.has(expressionToString(node))) {
			log(`Skipping WHERE node handled by join pushdown: ${expressionToString(node)}`);
			return;
		}

		if (node.type === 'binary') {
			if (node.operator.toUpperCase() === 'AND') {
				compileRecursive(node.left);
				compileRecursive(node.right);
			} else if (node.operator.toUpperCase() === 'OR') {
				// OR compilation needs careful state management if parts are handled/unhandled
				// For now, assume if OR itself wasn't handled, compile the whole thing.
				log(`Compiling unhandled OR expression: ${expressionToString(node)}`);
				const tempReg = compiler.allocateMemoryCells(1);
				// Pass activeCursors for potential correlation inside OR branches
				compiler.compileExpression(node, tempReg, analyzeSubqueryCorrelation(compiler, node, new Set(activeCursors)));
				compiler.emit(Opcode.IfFalse, tempReg, jumpTargetIfFalse, 0, null, 0, "Check unhandled: OR");
			} else {
				// Handle other binary operators (=, <, >, LIKE, etc.)
				log(`Compiling unhandled binary expression: ${expressionToString(node)}`);
				const tempReg = compiler.allocateMemoryCells(1);
				// Call compileBinary directly to ensure collation is handled
				compiler.compileBinary(node, tempReg, analyzeSubqueryCorrelation(compiler, node, new Set(activeCursors)));
				compiler.emit(Opcode.IfFalse, tempReg, jumpTargetIfFalse, 0, null, 0, `Check unhandled: ${node.operator}`);
			}
		} else if (node.type === 'unary') {
			// Handle unary operators (NOT, IS NULL, etc.)
			log(`Compiling unhandled unary expression: ${expressionToString(node)}`);
			const tempReg = compiler.allocateMemoryCells(1);
			// Call compileUnary directly
			compiler.compileUnary(node, tempReg, analyzeSubqueryCorrelation(compiler, node, new Set(activeCursors)));
			compiler.emit(Opcode.IfFalse, tempReg, jumpTargetIfFalse, 0, null, 0, `Check unhandled: ${node.operator}`);
		} else if (node.type === 'collate') {
			// If we encounter a COLLATE node directly that wasn't handled,
			// it implies its inner expression (likely a comparison) needs checking WITH the collation.
			// The inner expression itself wouldn't have been marked handled.
			// So, we simply compile the COLLATE node using compileExpression,
			// which eventually calls compileBinary/Unary for the inner part,
			// and *that* compileBinary/Unary call needs to correctly detect the COLLATE wrapper.
			// This seems okay based on compileBinary's logic.
			log(`Compiling unhandled COLLATE expression: ${expressionToString(node)}`);
			const tempReg = compiler.allocateMemoryCells(1);
			compiler.compileExpression(node, tempReg, analyzeSubqueryCorrelation(compiler, node, new Set(activeCursors)));
			compiler.emit(Opcode.IfFalse, tempReg, jumpTargetIfFalse, 0, null, 0, `Check unhandled: COLLATE`);

		} else {
			// Handle other simple expressions (e.g., function call, column reference directly in WHERE)
			log(`Compiling unhandled other expression: ${expressionToString(node)}`);
			const tempReg = compiler.allocateMemoryCells(1);
			compiler.compileExpression(node, tempReg, analyzeSubqueryCorrelation(compiler, node, new Set(activeCursors)));
			// Emit the jump
			compiler.emit(Opcode.IfFalse, tempReg, jumpTargetIfFalse, 0, null, 0, `Check unhandled: ${node.type}`);
		}
	};

	compileRecursive(expr);
}

