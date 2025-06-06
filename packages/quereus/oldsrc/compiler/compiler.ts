import { StatusCode, type SqlValue } from '../common/types.js';
import { QuereusError, ParseError } from '../common/errors.js';
import { Opcode } from '../vdbe/opcodes.js';
import { type P4SortKey, type VdbeInstruction } from '../vdbe/instruction.js';
import type { VdbeProgram } from '../vdbe/program.js';
import type { Database } from '../core/database.js';
import type { TableSchema } from '../schema/table.js';
import type * as AST from '../parser/ast.js';
import * as CompilerState from './compilerState.js';
import * as EphemeralCore from './ephemeral.js';
import * as FromClauseCore from './fromClause.js';
import * as PlannerHelper from './planner/helpers.js';
import * as WhereVerify from './where-verify.js';
import { compileExpression } from './expression.js';
import * as StmtCompiler from './statement.js';
import * as DdlCompiler from './ddl.js';
import * as SelectCompiler from './select.js';
import * as SelectCore from './select-core.js';
import type { SubqueryCorrelationResult } from './correlation.js';
import * as SubqueryCompiler from './subquery.js';
import type { ArgumentMap } from './handlers.js';
import * as ExprHandlers from './handlers.js';
import * as Utils from './utils.js';
import type { MemoryTable } from '../vtab/memory/table.js';
import { createLogger } from '../common/logger.js';
import { patchJumpAddresses } from './compilerState.js';
import type { CteInfo, CursorPlanningResult, SubroutineInfo, HavingContext, ColumnResultInfo } from './structs.js';
import { beginSubroutineHelper, endSubroutineHelper } from './compilerState.js';
import { createEphemeralTableHelper } from './ephemeral.js';
import { compileWithClauseHelper } from './cte.js';
import type { PlannedStep } from './planner/types.js';
import { safeJsonStringify } from '../util/serialization.js';

const log = createLogger('compiler');
const warnLog = log.extend('warn');

/**
 * Compiler class translating SQL AST nodes to VDBE programs
 */
export class Compiler {
	// Properties made public for helper access
	public db: Database;
	public sql: string = '';
	public constants: SqlValue[] = [];
	public instructions: VdbeInstruction[] = [];
	// --- Register/Cursor Allocation ---
	public numMemCells = 0; // Max stack slot index used across all frames
	public numCursors = 0;
	// ---------------------------------
	// --- Placeholder Management (NEW) ---
	public pendingPlaceholders: Map<number, { instructionIndex: number, targetArray: VdbeInstruction[], purpose: string }> = new Map();
	public nextPlaceholderId: number = -1; // Use unique negative IDs
	public resolvedAddresses: Map<number, number> = new Map(); // ADDED: Store resolved addresses
	// ------------------------------------
	public parameters: Map<number | string, { memIdx: number }> = new Map();
	public columnAliases: string[] = [];
	public cteMap: Map<string, CteInfo> = new Map(); // Map CTE name -> Info
	public tableSchemas: Map<number, TableSchema> = new Map(); // Map cursor index to schema
	public tableAliases: Map<string, number> = new Map(); // Map alias/name -> cursor index
	public ephemeralTableInstances: Map<number, MemoryTable> = new Map();
	public resultColumns: { name: string, table?: string, expr?: AST.Expression }[] = [];
	public cursorPlanningInfo: Map<number, CursorPlanningResult> = new Map();
	public cteReferenceCounts: Map<string, number> = new Map(); // Map lower-case CTE name -> reference count
	public _currentPlannedSteps: ReadonlyArray<PlannedStep> | null = null; // For EXPLAIN
	// --- Subroutine State ---
	public subroutineCode: VdbeInstruction[] = [];
	public subroutineDefs: Map<AST.SelectStmt, SubroutineInfo> = new Map();
	public subroutineDepth = 0;
	public currentFrameEnterInsn: VdbeInstruction | null = null; // Track FrameEnter to patch size
	public maxLocalOffsetInCurrentFrame = 0; // Track max offset for FrameEnter P1
	public subroutineFrameStack: { frameEnterInsn: VdbeInstruction | null; maxOffset: number }[] = [];
	// --- Stack Pointers ---
	// VDBE reserves stack slots 0 and 1 in a frame for control info if FrameEnter/FrameLeave are used.
	// Even for the main program (FP=0), some opcodes using setMem assume offset >= 2.
	// Initialize stackPointer to 2 to avoid using slots 0, 1 for general allocation.
	public stackPointer = 2; // Current stack top (absolute index)
	public framePointer = 0; // Current frame base (absolute index)
	// --- End Stack Pointers ---
	public outerCursors: number[] = []; // Cursors from outer query available to subquery

	constructor(db: Database) {
		this.db = db;
	}

	/**
	 * Compile an AST node into a VDBE program
	 *
	 * @param ast The Abstract Syntax Tree node to compile
	 * @param sql The original SQL text
	 * @returns The compiled VDBE program
	 */
	compile(ast: AST.AstNode, sql: string): VdbeProgram {
		try {
			// Reset state
			this.sql = sql;
			this.constants = [];
			this.instructions = [];
			this.numMemCells = 0;
			this.numCursors = 0;
			this.parameters = new Map();
			this.columnAliases = [];
			this.cteMap = new Map();
			this.tableSchemas = new Map();
			this.tableAliases = new Map();
			this.ephemeralTableInstances = new Map();
			this.resultColumns = [];
			this.cursorPlanningInfo = new Map();
			this.cteReferenceCounts = new Map();
			// --- Reset Placeholder State (NEW) ---
			this.pendingPlaceholders = new Map();
			this.nextPlaceholderId = -1;
			this.resolvedAddresses = new Map();
			// -------------------------------------
			this.subroutineCode = [];
			this.subroutineDefs = new Map();
			this.subroutineDepth = 0;
			this.currentFrameEnterInsn = null;
			this.maxLocalOffsetInCurrentFrame = 0;
			this.subroutineFrameStack = [];
			// Initialize stack and frame pointers for the main program block.
			// FP=0 for main. SP starts at 2 because VDBE opcodes using setMem (like Affinity)
			// expect offsets >= 2 due to VDBE's localsStartOffset.
			this.stackPointer = 2;
			this.framePointer = 0;
			this.outerCursors = [];
			this._currentPlannedSteps = null; // Reset for EXPLAIN
			// --- End Reset State ---

			// Add initial Init instruction
			this.emit(Opcode.Init, 0, 1, 0, null, 0, "Start of program"); // Start PC=1

			// --- Analyze CTE references before compiling WITH --- //
			let withClause: AST.WithClause | undefined;
			if ('with' in ast && (ast as any).withClause !== undefined) {
				withClause = (ast as any).withClause;
				if (withClause) {
					// Initialize counts for all defined CTEs
					for (const cte of withClause.ctes) {
						this.cteReferenceCounts.set(cte.name.toLowerCase(), 0);
					}
					// Perform the analysis
					// this._analyzeCteReferences(ast, withClause); // REMOVED - Assume handled elsewhere or refactored out
				}
			}
			// -------------------------------------------------------- //

			// Compile WITH clause (Now uses the counts)
			if (withClause) {
				this.compileWithClause(withClause);
			}

			// Compile main statement (ensure casts are still present)
			switch (ast.type) {
				case 'select':
					this.compileSelect(ast as AST.SelectStmt);
					break;
				case 'insert':
					this.compileInsert(ast as AST.InsertStmt);
					break;
				case 'update':
					this.compileUpdate(ast as AST.UpdateStmt);
					break;
				case 'delete':
					this.compileDelete(ast as AST.DeleteStmt);
					break;
				case 'createTable':
					this.compileCreateTable(ast as AST.CreateTableStmt);
					break;
				case 'createIndex':
					this.compileCreateIndex(ast as AST.CreateIndexStmt);
					break;
				case 'createView':
					this.compileCreateView(ast as AST.CreateViewStmt);
					break;
				case 'drop':
					this.compileDrop(ast as AST.DropStmt);
					break;
				case 'alterTable':
					this.compileAlterTable(ast as AST.AlterTableStmt);
					break;
				case 'begin':
					this.compileBegin(ast as AST.BeginStmt);
					break;
				case 'commit':
					this.compileCommit(ast as AST.CommitStmt);
					break;
				case 'rollback':
					this.compileRollback(ast as AST.RollbackStmt);
					break;
				case 'savepoint':
					this.compileSavepoint(ast as AST.SavepointStmt);
					break;
				case 'release':
					this.compileRelease(ast as AST.ReleaseStmt);
					break;
				case 'pragma':
					this.compilePragma(ast as AST.PragmaStmt);
					break;
				default:
					throw new QuereusError(`Compilation not implemented for statement type: ${(ast as any).type}`);
			}

			// Append Halt instruction
			this.emit(Opcode.Halt, StatusCode.OK, 0, 0, null, 0, "End of program");

			// Append subroutine code
			this.instructions.push(...this.subroutineCode);

			// Patch jump addresses
			patchJumpAddresses(this);

			// Create program
			return {
				instructions: this.instructions,
				constants: this.constants,
				numMemCells: this.numMemCells + 1, // VDBE needs one more than max index used
				numCursors: this.numCursors,
				parameters: this.parameters,
				columnNames: this.columnAliases,
				sql: this.sql,
				plannedSteps: this._currentPlannedSteps ?? undefined
			};
		} catch (error) {
			if (error instanceof ParseError) {
				// Re-throw ParseError as QuereusError, preserving location and cause
				throw new QuereusError(
					error.message,
					StatusCode.ERROR,
					error,
					error.token.startLine, // Use token location from ParseError
					error.token.startColumn
				);
			} else if (error instanceof QuereusError) {
				throw error;
			} else {
				// Wrap other unexpected errors
				throw new QuereusError(
					`Unexpected compiler error: ${error instanceof Error ? error.message : String(error)}`,
					StatusCode.INTERNAL,
					error instanceof Error ? error : undefined
				);
			}
		}
	}

	// --- Wrapper Methods Delegating to Helpers (Primarily from incoming, with adjustments) --- //

	// Compiler State Helpers
	allocateMemoryCells(count: number): number { return CompilerState.allocateMemoryCellsHelper(this, count); }
	allocateCursor(): number { return CompilerState.allocateCursorHelper(this); }
	addConstant(value: SqlValue): number { return CompilerState.addConstantHelper(this, value); }
	emit(opcode: Opcode, p1?: number, p2?: number, p3?: number, p4?: any, p5?: number, comment?: string): number {
		// --- BEGIN ADDED LOGGING ---
		const p4String = typeof p4 === 'string' ? p4.substring(0, 70) : (p4 !== null && p4 !== undefined ? safeJsonStringify(p4).substring(0, 70) : String(p4));
		log(
			'Compiler.emit: Opcode=%s(%d), P1=%s, P2=%s, P3=%s, P4=%s..., P5=%s, Comment=%s',
			Opcode[opcode], opcode, String(p1), String(p2), String(p3), p4String, String(p5), comment || ''
		);
		if (p1 === -3 || p2 === -3 || p3 === -3) {
			warnLog(`Placeholder -3 DETECTED in Opcode ${Opcode[opcode]}(${opcode}): p1=${p1}, p2=${p2}, p3=${p3}. P4=${p4String}`);
		}
		// --- END ADDED LOGGING ---
		return CompilerState.emitInstruction(this, opcode, p1, p2, p3, p4, p5, comment);
	}
	allocateAddress(purpose: string = 'unknown'): number { return CompilerState.allocateAddressHelper(this, purpose); }
	resolveAddress(placeholder: number): number { return CompilerState.resolveAddressHelper(this, placeholder); }
	getCurrentAddress(): number { return CompilerState.getCurrentAddressHelper(this); }

	// FROM Clause Helper
	compileFromCore(sources: AST.FromClause[] | undefined): number[] { return FromClauseCore.compileFromCoreHelper(this, sources); }

	// Query Planning Helpers
	planTableAccess(cursorIdx: number, tableSchema: TableSchema, stmt: AST.SelectStmt | AST.UpdateStmt | AST.DeleteStmt, activeOuterCursors: ReadonlySet<number>, relevantConstraints?: AST.Expression): void {
		PlannerHelper.planTableAccessHelper(this, cursorIdx, tableSchema, stmt, activeOuterCursors, relevantConstraints);
	}
	verifyWhereConstraints(cursorIdx: number, jumpTargetIfFalse: number): void { WhereVerify.verifyWhereConstraintsHelper(this, cursorIdx, jumpTargetIfFalse); }

	// Expressions
	compileExpression(expr: AST.Expression, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap, overrideCollation?: string): void { compileExpression(this, expr, targetReg, correlation, havingContext, argumentMap, overrideCollation); }
	compileLiteral(expr: AST.LiteralExpr, targetReg: number): void { Utils.compileLiteralValue(this, expr.value, targetReg); }
	compileColumn(expr: AST.ColumnExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void { ExprHandlers.compileColumn(this, expr, targetReg, correlation, havingContext, argumentMap); }
	compileBinary(expr: AST.BinaryExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void { ExprHandlers.compileBinary(this, expr, targetReg, correlation, havingContext, argumentMap); }
	compileUnary(expr: AST.UnaryExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void { ExprHandlers.compileUnary(this, expr, targetReg, correlation, havingContext, argumentMap); }
	compileCast(expr: AST.CastExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void { ExprHandlers.compileCast(this, expr, targetReg, correlation, havingContext, argumentMap); }
	compileCollate(expr: AST.CollateExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void { ExprHandlers.compileCollate(this, expr, targetReg, correlation, havingContext, argumentMap); }
	compileFunction(expr: AST.FunctionExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void { ExprHandlers.compileFunction(this, expr, targetReg, correlation, havingContext, argumentMap); }
	compileParameter(expr: AST.ParameterExpr, targetReg: number): void { ExprHandlers.compileParameter(this, expr, targetReg); }

	// Subqueries
	compileSubquery(expr: AST.SubqueryExpr, targetReg: number): void { SubqueryCompiler.compileSubquery(this, expr, targetReg); }
	compileScalarSubquery(subQuery: AST.SelectStmt, targetReg: number): void { SubqueryCompiler.compileScalarSubquery(this, subQuery, targetReg); }
	compileInSubquery(leftExpr: AST.Expression, subQuery: AST.SelectStmt, targetReg: number, invert: boolean): void { SubqueryCompiler.compileInSubquery(this, leftExpr, subQuery, targetReg, invert); }
	compileComparisonSubquery(leftExpr: AST.Expression, op: string, subQuery: AST.SelectStmt, targetReg: number): void { SubqueryCompiler.compileComparisonSubquery(this, leftExpr, op, subQuery, targetReg); }
	compileExistsSubquery(subQuery: AST.SelectStmt, targetReg: number): void { SubqueryCompiler.compileExistsSubquery(this, subQuery, targetReg); }

	// Statements
	compileSelect(stmt: AST.SelectStmt): void { SelectCompiler.compileSelectStatement(this, stmt); }
	compileInsert(stmt: AST.InsertStmt): void { StmtCompiler.compileInsertStatement(this, stmt); }
	compileUpdate(stmt: AST.UpdateStmt): void { StmtCompiler.compileUpdateStatement(this, stmt); }
	compileDelete(stmt: AST.DeleteStmt): void { StmtCompiler.compileDeleteStatement(this, stmt); }
	compileCreateTable(stmt: AST.CreateTableStmt): void { DdlCompiler.compileCreateTableStatement(this, stmt); }
	compileCreateIndex(stmt: AST.CreateIndexStmt): void { DdlCompiler.compileCreateIndexStatement(this, stmt); }
	compileCreateView(stmt: AST.CreateViewStmt): void { DdlCompiler.compileCreateViewStatement(this, stmt); }
	compileDrop(stmt: AST.DropStmt): void { DdlCompiler.compileDropStatement(this, stmt); }
	compileAlterTable(stmt: AST.AlterTableStmt): void { DdlCompiler.compileAlterTableStatement(this, stmt); }
	compileBegin(stmt: AST.BeginStmt): void { DdlCompiler.compileBeginStatement(this, stmt); }
	compileCommit(stmt: AST.CommitStmt): void { DdlCompiler.compileCommitStatement(this, stmt); }
	compileRollback(stmt: AST.RollbackStmt): void { StmtCompiler.compileRollbackStatement(this, stmt); }
	compileSavepoint(stmt: AST.SavepointStmt): void { StmtCompiler.compileSavepointStatement(this, stmt); }
	compileRelease(stmt: AST.ReleaseStmt): void { StmtCompiler.compileReleaseStatement(this, stmt); }
	compilePragma(stmt: AST.PragmaStmt): void { DdlCompiler.compilePragmaStatement(this, stmt); }

	beginSubroutine(numArgs: number, argMap?: ArgumentMap): number { return beginSubroutineHelper(this, numArgs, argMap); }
	endSubroutine(): void { endSubroutineHelper(this); }
	createEphemeralSchema(cursorIdx: number, numCols: number, sortKey?: P4SortKey): TableSchema { return createEphemeralTableHelper(this, cursorIdx, numCols, sortKey); }
	compileWithClause(withClause: AST.WithClause): void { compileWithClauseHelper(this, withClause); }
	getSelectCoreStructure(stmt: AST.SelectStmt, outerCursors: number[], correlation?: SubqueryCorrelationResult, argumentMap?: ArgumentMap): { resultBaseReg: number, numCols: number, columnMap: ColumnResultInfo[] } {
		return SelectCore.getSelectCoreStructure(this, stmt, outerCursors, correlation, argumentMap);
	}
	closeCursorsUsedBySelect(cursors: number[]): void { EphemeralCore.closeCursorsUsedBySelectHelper(this, cursors); }
}

