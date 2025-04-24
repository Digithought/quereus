import { Opcode, IndexConstraintOp } from '../common/constants';
import type { Compiler } from './compiler';
import type * as AST from '../parser/ast';

// --- WHERE Clause Verification and Unhandled Compilation --- //

/**
 * Emits VDBE code to verify constraints that were used by the plan but not marked as 'omit'.
 * This prevents incorrect results if xFilter returns rows that don't strictly match the original WHERE clause.
 */
export function verifyWhereConstraintsHelper(
	compiler: Compiler,
	cursorIdx: number,
	jumpTargetIfFalse: number // Address to jump to if verification fails
): void {
	const planningInfo = compiler.cursorPlanningInfo.get(cursorIdx);
	if (!planningInfo || planningInfo.constraints.length === 0 || planningInfo.usage.every(u => u.argvIndex === 0)) {
		return;
	}

	const tempReg = compiler.allocateMemoryCells(1);
	const tableSchema = compiler.tableSchemas.get(cursorIdx);
	if (!tableSchema) throw new Error(`Internal: Schema missing for cursor ${cursorIdx} during verification`);

	for (let i = 0; i < planningInfo.constraints.length; i++) {
		const constraint = planningInfo.constraints[i];
		const usage = planningInfo.usage[i];

		if (usage.argvIndex > 0 && !usage.omit) {
			const originalValueExpr = planningInfo.constraintExpressions.get(i);
			let verificationExpr: AST.Expression | null = null;
			let verificationExprLoc: AST.AstNode['loc'] | undefined = originalValueExpr?.loc;

			if (constraint.iColumn === -1) {
				console.warn(`Verification of rowid constraint (constraint ${i}) not implemented.`);
				continue;
			}

			const colName = tableSchema.columns[constraint.iColumn]?.name;
			if (!colName) {
				console.error(`Cannot find column name for index ${constraint.iColumn} in table ${tableSchema.name} during verification.`);
				continue;
			}
			const colExpr: AST.ColumnExpr = { type: 'column', name: colName };

			if (constraint.op === IndexConstraintOp.ISNULL || constraint.op === IndexConstraintOp.ISNOTNULL) {
				if (originalValueExpr?.type === 'unary') {
					verificationExpr = { ...originalValueExpr, expr: colExpr };
					verificationExprLoc = originalValueExpr.loc;
				} else {
					console.warn(`Cannot reconstruct IS NULL/IS NOT NULL verification expression for constraint ${i}.`);
					continue;
				}
			}
			else {
				if (!originalValueExpr) {
					console.warn(`Could not find original value expression for constraint verification (cursor ${cursorIdx}, constraint ${i}, op ${constraint.op})`);
					continue;
				}
				const invOpMap: { [key in IndexConstraintOp]?: { op: string, swap?: boolean } } = {
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
					[IndexConstraintOp.MATCH]: { op: 'MATCH' },
				};
				const opInfo = invOpMap[constraint.op];
				if (!opInfo) {
					console.warn(`Cannot map constraint op ${constraint.op} back to AST operator for verification.`);
					continue;
				}

				const binaryExpr: AST.BinaryExpr = { type: 'binary', operator: opInfo.op, left: colExpr, right: originalValueExpr, loc: verificationExprLoc };
				verificationExpr = binaryExpr;
			}

			if (verificationExpr) {
				compiler.compileExpression(verificationExpr, tempReg);
				const opStr = (verificationExpr.type === 'unary' ? verificationExpr.operator : (verificationExpr.type === 'binary' ? verificationExpr.operator : `op${constraint.op}`));
				compiler.emit(Opcode.IfFalse, tempReg, jumpTargetIfFalse, 0, null, 0, `Verify constraint ${i} (${opStr})`);
			}
		}
	}
}

/**
 * Compiles only the parts of a WHERE expression that were NOT handled by
 * the query plan (xBestIndex or verifyWhereConstraintsHelper).
 */
export function compileUnhandledWhereConditions(
	compiler: Compiler,
	expr: AST.Expression | undefined,
	activeCursors: number[], // Cursors active in the current loop level
	jumpTargetIfFalse: number
): void {
	if (!expr) {
		return;
	}

	const allHandledNodes = new Set<AST.Expression>();
	activeCursors.forEach(cursorIdx => {
		compiler.cursorPlanningInfo.get(cursorIdx)?.handledWhereNodes.forEach(node => {
			allHandledNodes.add(node);
		});
	});

	const compileRecursive = (node: AST.Expression) => {
		if (allHandledNodes.has(node)) {
			return;
		}

		if (node.type === 'binary') {
			if (node.operator.toUpperCase() === 'AND') {
				compileRecursive(node.left);
				compileRecursive(node.right);
			} else if (node.operator.toUpperCase() === 'OR') {
				const orReg = compiler.allocateMemoryCells(1);
				const addrOrTrue = compiler.allocateAddress();
				compiler.compileExpression(node.left, orReg);
				compiler.emit(Opcode.IfTrue, orReg, addrOrTrue, 0, null, 0, "OR: check left");
				compiler.compileExpression(node.right, orReg);
				compiler.emit(Opcode.IfFalse, orReg, jumpTargetIfFalse, 0, null, 0, "OR: check right, jump if false");
				compiler.resolveAddress(addrOrTrue);
			} else {
				const tempReg = compiler.allocateMemoryCells(1);
				compiler.compileExpression(node, tempReg);
				compiler.emit(Opcode.IfFalse, tempReg, jumpTargetIfFalse, 0, null, 0, `Check unhandled: ${node.operator}`);
			}
		} else if (node.type === 'unary') {
			const tempReg = compiler.allocateMemoryCells(1);
			compiler.compileExpression(node, tempReg);
			compiler.emit(Opcode.IfFalse, tempReg, jumpTargetIfFalse, 0, null, 0, `Check unhandled: ${node.operator}`);
		} else {
			const tempReg = compiler.allocateMemoryCells(1);
			compiler.compileExpression(node, tempReg);
			compiler.emit(Opcode.IfFalse, tempReg, jumpTargetIfFalse, 0, null, 0, `Check unhandled: ${node.type}`);
		}
	};

	compileRecursive(expr);
}
