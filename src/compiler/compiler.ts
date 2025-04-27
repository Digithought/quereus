/**
 * SQL Compiler for SQLiter
 *
 * Translates SQL AST into VDBE instructions
 */
import { StatusCode, type SqlValue } from '../common/types.js';
import { SqliteError, ParseError } from '../common/errors.js';
import { Opcode } from '../vdbe/opcodes.js';
import { type P4SortKey, type VdbeInstruction, createInstruction, type P4FuncDef } from '../vdbe/instruction.js';
import type { VdbeProgram } from '../vdbe/program.js';
import type { WithClause } from '../parser/ast.js';
import type { Database } from '../core/database.js';
import type { TableSchema } from '../schema/table.js';
import type * as AST from '../parser/ast.js';
import * as CompilerState from './compilerState.js';
import * as EphemeralCore from './ephemeral.js';
import * as FromClauseCore from './fromClause.js';
import * as QueryPlanner from './queryPlanner.js';
import * as WhereVerify from './whereVerify.js';
import * as ExprHandlers from './handlers.js';
import { compileExpression } from './expression.js';
import * as StmtCompiler from './statement.js';
import * as DdlCompiler from './ddl.js';
import * as SelectCompiler from './select.js';
import * as Utils from './utils.js';
import type { SubqueryCorrelationResult } from './correlation.js';
import * as SubqueryCompiler from './subquery.js';
import type { ArgumentMap } from './handlers.js';
import { compileCommonTableExpression } from './cte.js';
import type { IndexConstraint, IndexConstraintUsage } from '../vtab/indexInfo.js';
import type { MemoryTable } from '../vtab/memory/table.js';

// --- Result/CTE Info types --- //
export interface ColumnResultInfo {
	targetReg: number;
	sourceCursor: number; // -1 if not from a direct column
	sourceColumnIndex: number; // -1 if not from a direct column
	expr?: AST.Expression; // The expression that generated this result column
}
export interface HavingContext {
	finalColumnMap: ReadonlyArray<ColumnResultInfo>;
}
export interface SubroutineInfo {
	startAddress: number;
	correlation: SubqueryCorrelationResult;
	regSubqueryHasNullOutput?: number;
}
export interface CteInfo {
	type: 'materialized';
	cursorIdx: number;
	schema: TableSchema;
}
export interface CursorPlanningResult {
	idxNum: number;
	idxStr: string | null;
	usage: IndexConstraintUsage[];
	cost: number;
	rows: bigint;
	orderByConsumed: boolean;
	constraints: IndexConstraint[];
	constraintExpressions: ReadonlyMap<number, AST.Expression>;
	handledWhereNodes: ReadonlySet<AST.Expression>;
}

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
	private currentFrameLocals = 0; // Tracks highest local offset used in the *current* frame
	public numCursors = 0;
	// ---------------------------------
	public parameters: Map<number | string, { memIdx: number }> = new Map();
	public columnAliases: string[] = [];
	public cteMap: Map<string, CteInfo> = new Map(); // Map CTE name -> Info
	public tableSchemas: Map<number, TableSchema> = new Map(); // Map cursor index to schema
	public tableAliases: Map<string, number> = new Map(); // Map alias/name -> cursor index
	public ephemeralTableInstances: Map<number, MemoryTable> = new Map();
	public resultColumns: { name: string, table?: string, expr?: AST.Expression }[] = [];
	public cursorPlanningInfo: Map<number, CursorPlanningResult> = new Map();
	// --- Subroutine State ---
	private subroutineCode: VdbeInstruction[] = [];
	public subroutineDefs: Map<AST.SelectStmt, SubroutineInfo> = new Map();
	public subroutineDepth = 0;
	private currentFrameEnterInsn: VdbeInstruction | null = null; // Track FrameEnter to patch size
	private maxLocalOffsetInCurrentFrame = 0; // Track max offset for FrameEnter P1
	private subroutineFrameStack: { frameEnterInsn: VdbeInstruction | null; maxOffset: number }[] = [];
	// --- Stack Pointers ---
	public stackPointer: number = 0; // Current stack top (absolute index)
	public framePointer: number = 0; // Current frame base (absolute index)
	public outerCursors: number[] = [];

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
			this.subroutineCode = [];
			this.subroutineDefs = new Map();
			this.subroutineDepth = 0;
			this.currentFrameLocals = 0;
			this.currentFrameEnterInsn = null;
			this.maxLocalOffsetInCurrentFrame = 0;
			this.stackPointer = 0;
			this.framePointer = 0;
			this.outerCursors = [];
			this.subroutineFrameStack = [];

			// Add initial Init instruction
			this.emit(Opcode.Init, 0, 1, 0, null, 0, "Start of program"); // Start PC=1

			// Compile WITH clause first if present
			let withClause: WithClause | undefined;
			if ('withClause' in ast && (ast as any).withClause !== undefined) {
				withClause = (ast as any).withClause;
				this.compileWithClause(withClause);
			}

			// Compile by node type
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
					throw new SqliteError(`Unsupported statement type: ${(ast as any).type}`, StatusCode.ERROR);
			}

			// Append subroutines after main program
			if (this.subroutineCode.length > 0) {
				this.instructions.push(...this.subroutineCode);
				this.subroutineCode = [];
			}

			// End program with Halt
			this.emit(Opcode.Halt, StatusCode.OK, 0, 0, null, 0, "End of program");

			// Create program
			return {
				instructions: this.instructions,
				constants: this.constants,
				numMemCells: this.numMemCells + 1, // VDBE needs one more than max index used
				numCursors: this.numCursors,
				parameters: this.parameters,
				columnNames: this.columnAliases,
				sql: this.sql
			};
		} catch (error) {
			if (error instanceof ParseError) {
				// Re-throw ParseError as SqliteError, preserving location and cause
				throw new SqliteError(
					error.message,
					StatusCode.ERROR,
					error,
					error.line,
					error.column
				);
			} else if (error instanceof SqliteError) {
				throw error;
			} else {
				// Wrap other unexpected errors
				throw new SqliteError(
					`Unexpected compiler error: ${error instanceof Error ? error.message : String(error)}`,
					StatusCode.INTERNAL,
					error instanceof Error ? error : undefined
				);
			}
		}
	}

	/**
	 * Starts a subroutine compilation context by setting up a new frame
	 *
	 * @returns The address of the FrameEnter instruction
	 */
	startSubroutineCompilation(): number {
		this.subroutineDepth++;
		this.subroutineFrameStack.push({
			frameEnterInsn: this.currentFrameEnterInsn,
			maxOffset: this.maxLocalOffsetInCurrentFrame,
		});

		this.maxLocalOffsetInCurrentFrame = 0;
		const instruction = createInstruction(Opcode.FrameEnter, 0, 0, 0, null, 0, `Enter Subroutine Frame Depth ${this.subroutineDepth}`);
		this.subroutineCode.push(instruction);
		const frameEnterAddr = this.subroutineCode.length - 1;
		this.currentFrameEnterInsn = instruction;

		return frameEnterAddr;
	}

	/**
	 * Ends a subroutine compilation context by patching the frame size
	 * and restoring the previous frame context
	 */
	endSubroutineCompilation(): void {
		if (this.subroutineDepth > 0) {
			if (this.currentFrameEnterInsn) {
				const frameSize = this.maxLocalOffsetInCurrentFrame + 1;
				this.currentFrameEnterInsn.p1 = frameSize;
			} else {
				console.error("Compiler Error: Missing FrameEnter tracking for the current frame being ended.");
			}

			this.subroutineDepth--;

			const previousFrame = this.subroutineFrameStack.pop();
			if (previousFrame) {
				this.currentFrameEnterInsn = previousFrame.frameEnterInsn;
				this.maxLocalOffsetInCurrentFrame = previousFrame.maxOffset;
			} else {
				this.currentFrameEnterInsn = null;
				this.maxLocalOffsetInCurrentFrame = 0;
				if (this.subroutineDepth !== 0) {
					console.error("Compiler Error: Subroutine stack underflow or depth mismatch.");
				}
			}
		} else {
			console.warn("Attempted to end subroutine compilation at depth 0");
		}
	}

	// --- Wrapper Methods Delegating to Helpers --- //

	// Compiler State Helpers
	allocateMemoryCells(count: number): number { return CompilerState.allocateMemoryCellsHelper(this, count); }
	allocateCursor(): number { return CompilerState.allocateCursorHelper(this); }
	addConstant(value: SqlValue): number { return CompilerState.addConstantHelper(this, value); }
	emit(opcode: Opcode, p1?: number, p2?: number, p3?: number, p4?: any, p5?: number, comment?: string): number { return CompilerState.emitInstruction(this, opcode, p1, p2, p3, p4, p5, comment); }
	allocateAddress(): number { return CompilerState.allocateAddressHelper(this); }
	resolveAddress(placeholder: number): void { CompilerState.resolveAddressHelper(this, placeholder); }
	getCurrentAddress(): number { return CompilerState.getCurrentAddressHelper(this); }

	// Ephemeral Table Helpers
	createEphemeralSchema(cursorIdx: number, numCols: number, sortKey?: P4SortKey): TableSchema {
		if (!this.ephemeralTableInstances) {
			this.ephemeralTableInstances = new Map<number, MemoryTable>();
		}
		return EphemeralCore.createEphemeralTableHelper(this, cursorIdx, numCols, sortKey);
	}
	closeCursorsUsedBySelect(cursors: number[]): void { EphemeralCore.closeCursorsUsedBySelectHelper(this, cursors); }

	// FROM Clause Helper
	compileFromCore(sources: AST.FromClause[] | undefined): number[] { return FromClauseCore.compileFromCoreHelper(this, sources); }

	// Query Planning Helpers
	planTableAccess(cursorIdx: number, tableSchema: TableSchema, stmt: AST.SelectStmt | AST.UpdateStmt | AST.DeleteStmt, activeOuterCursors: ReadonlySet<number>): void { QueryPlanner.planTableAccessHelper(this, cursorIdx, tableSchema, stmt, activeOuterCursors); }
	verifyWhereConstraints(cursorIdx: number, jumpTargetIfFalse: number): void { WhereVerify.verifyWhereConstraintsHelper(this, cursorIdx, jumpTargetIfFalse); }

	// Expressions
	compileExpression(expr: AST.Expression, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void { compileExpression(this, expr, targetReg, correlation, havingContext, argumentMap); }
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
	compileSelectCore(stmt: AST.SelectStmt, outerCursorsForSelect: number[], correlation?: SubqueryCorrelationResult, argumentMap?: ArgumentMap): { resultBaseReg: number, numCols: number, columnMap: ColumnResultInfo[] } {
		return SelectCompiler.compileSelectCoreStatement(this, stmt, outerCursorsForSelect, correlation, argumentMap);
	}

	/**
	 * Compiles a WITH clause by materializing each CTE
	 *
	 * @param withClause The WITH clause to compile
	 */
	compileWithClause(withClause: WithClause | undefined): void {
		if (!withClause) {
			return;
		}

		console.log(`Compiling WITH${withClause.recursive ? ' RECURSIVE' : ''} clause...`);

		for (const cte of withClause.ctes) {
			const cteNameLower = cte.name.toLowerCase();
			if (this.cteMap.has(cteNameLower)) {
				throw new SqliteError(`Duplicate CTE name: '${cte.name}'`, StatusCode.ERROR);
			}
			compileCommonTableExpression(this, cte, withClause.recursive);
		}
		console.log("Finished compiling WITH clause.");
	}

	// Pragma handling
	compilePragma(stmt: AST.PragmaStmt): void { DdlCompiler.compilePragmaStatement(this, stmt); }
}

