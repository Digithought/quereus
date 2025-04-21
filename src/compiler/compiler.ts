/**
 * SQL Compiler for SQLiter
 *
 * Translates SQL AST into VDBE instructions
 */

import { StatusCode, type SqlValue } from '../common/types';
import { SqliteError } from '../common/errors';
import { Opcode } from '../common/constants';
import { type VdbeInstruction } from '../vdbe/instruction';
import type { VdbeProgram } from '../vdbe/program';
import type { Database } from '../core/database';
import type { TableSchema } from '../schema/table';
import type * as AST from '../parser/ast';
import * as Helpers from './helpers';
import * as ExprCompiler from './expression';
import * as StmtCompiler from './statement';
// --- Add Correlation Types ---
import type { CorrelatedColumnInfo, SubqueryCorrelationResult } from './helpers';
import type { ArgumentMap } from './expression'; // Import ArgumentMap
// ----------------------------

// Import implementations to merge methods onto the prototype
import './helpers';
import './expression';
import './statement';

// --- Add IndexInfo types ---
import type { IndexInfo, IndexConstraint, IndexOrderBy, IndexConstraintUsage } from '../vtab/indexInfo';
// --------------------------

// --- Define structure for planning results ---
export interface CursorPlanningResult {
	idxNum: number;
	idxStr: string | null;
	usage: IndexConstraintUsage[];
	cost: number;
	rows: bigint;
	orderByConsumed: boolean;
	constraints: IndexConstraint[]; // Keep track of constraints passed to xBestIndex
	constraintExpressions: ReadonlyMap<number, AST.Expression>;
	handledWhereNodes: ReadonlySet<AST.Expression>; // Track nodes handled by this plan
}
// ------------------------------------------

// --- Define structure for mapping result columns to source/expression ---
export interface ColumnResultInfo {
	targetReg: number;
	sourceCursor: number; // -1 if not from a direct column
	sourceColumnIndex: number; // -1 if not from a direct column
	expr?: AST.Expression; // The expression that generated this result column
}
// --------------------------------------------------------------------

// --- Add HAVING context type ---
export interface HavingContext {
	finalColumnMap: ReadonlyArray<ColumnResultInfo>;
}
// --------------------------------

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
	public tableSchemas: Map<number, TableSchema> = new Map(); // Map cursor index to schema
	public tableAliases: Map<string, number> = new Map(); // Map alias/name -> cursor index
	public ephemeralTables: Map<number, TableSchema> = new Map(); // Track ephemeral schemas
	public resultColumns: { name: string, table?: string, expr?: AST.Expression }[] = [];
	// --- Add planning info map ---
	public cursorPlanningInfo: Map<number, CursorPlanningResult> = new Map();
	// ----------------------------
	// --- Subroutine State ---
	private subroutineCode: VdbeInstruction[] = [];
	public subroutineDefs: Map<AST.SelectStmt, SubroutineInfo> = new Map();
	public subroutineDepth = 0;
	private currentFrameEnterInsn: VdbeInstruction | null = null; // Track FrameEnter to patch size
	private maxLocalOffsetInCurrentFrame = 0; // Track max offset for FrameEnter P1

	constructor(db: Database) {
		this.db = db;
	}

	/**
	 * Compile an AST node into a VDBE program
	 */
	compile(ast: AST.AstNode, sql: string): VdbeProgram {
		// Reset state
		this.sql = sql;
		this.constants = [];
		this.instructions = [];
		this.numMemCells = 0;
		this.numCursors = 0;
		this.parameters = new Map();
		this.columnAliases = [];
		this.tableSchemas = new Map();
		this.tableAliases = new Map(); // Reset aliases
		this.ephemeralTables = new Map();
		this.resultColumns = [];
		this.cursorPlanningInfo = new Map(); // Reset planning info
		// --- Reset subroutine state ---
		this.subroutineCode = [];
		this.subroutineDefs = new Map();
		this.subroutineDepth = 0;
		// --- Reset new fields ---
		this.currentFrameLocals = 0;
		this.currentFrameEnterInsn = null;
		this.maxLocalOffsetInCurrentFrame = 0;
		// -----------------------------

		// Add initial Init instruction
		this.emit(Opcode.Init, 0, 1, 0, null, 0, "Start of program"); // Start PC=1

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
			case 'createVirtualTable':
				this.compileCreateVirtualTable(ast as AST.CreateVirtualTableStmt);
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

			default:
				throw new SqliteError(`Unsupported statement type: ${(ast as any).type}`, StatusCode.ERROR);
		}

		// --- Append subroutines after main program ---
		if (this.subroutineCode.length > 0) {
			this.instructions.push(...this.subroutineCode);
		}
		// --------------------------------------------

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
	}

	// --- Update Subroutine Compilation Context ---
	startSubroutineCompilation(): number { // Return address of FrameEnter
		this.subroutineDepth++;
		// Reset tracking for the new frame
		this.maxLocalOffsetInCurrentFrame = 0;
		// Emit FrameEnter with placeholder size (0). Will be patched in endSubroutineCompilation.
		const frameEnterAddr = this.emit(Opcode.FrameEnter, 0, 0, 0, null, 0, `Enter Subroutine Frame Depth ${this.subroutineDepth}`);
		this.currentFrameEnterInsn = (this as any).subroutineCode[(this as any).subroutineCode.length - 1]; // Get ref
		// Reserve space for control info (RetAddr, OldFP) - Frame slots 0 and 1
		this.allocateMemoryCells(2);
		return frameEnterAddr;
	}
	endSubroutineCompilation(): void {
		if (this.subroutineDepth > 0) {
			// Patch the FrameEnter instruction with the calculated frame size
			if (this.currentFrameEnterInsn) {
				// Frame size = max local offset used + 1 (since offset is 0-based)
				const frameSize = this.maxLocalOffsetInCurrentFrame + 1;
				this.currentFrameEnterInsn.p1 = frameSize;
				this.currentFrameEnterInsn = null; // Clear for next subroutine
			} else {
				console.error("Compiler Error: Mismatched start/endSubroutineCompilation or missing FrameEnter tracking.");
			}
			this.subroutineDepth--;
			// No need to restore max offset tracking, handled by new frame start
		} else {
			console.warn("Attempted to end subroutine compilation at depth 0");
		}
	}
	// -----------------------------------------------

	// --- Wrapper Methods Delegating to Helpers ---

	// Helpers
	allocateMemoryCells(count: number): number { return Helpers.allocateMemoryCellsHelper(this, count); }
	allocateCursor(): number { return Helpers.allocateCursorHelper(this); }
	addConstant(value: SqlValue): number { return Helpers.addConstantHelper(this, value); }
	emit(opcode: Opcode, p1?: number, p2?: number, p3?: number, p4?: any, p5?: number, comment?: string): number { return Helpers.emitInstruction(this, opcode, p1, p2, p3, p4, p5, comment); }
	allocateAddress(): number { return Helpers.allocateAddressHelper(this); }
	resolveAddress(placeholder: number): void { Helpers.resolveAddressHelper(this, placeholder); }
	getCurrentAddress(): number { return Helpers.getCurrentAddressHelper(this); }
	createEphemeralSchema(cursorIdx: number, numCols: number): TableSchema { return Helpers.createEphemeralSchemaHelper(this, cursorIdx, numCols); }
	closeCursorsUsedBySelect(cursors: number[]): void { Helpers.closeCursorsUsedBySelectHelper(this, cursors); }
	compileFromCore(sources: AST.FromClause[] | undefined): number[] { return Helpers.compileFromCoreHelper(this, sources); }
	planTableAccess(cursorIdx: number, tableSchema: TableSchema, stmt: AST.SelectStmt | AST.UpdateStmt | AST.DeleteStmt, activeOuterCursors: ReadonlySet<number>): void { Helpers.planTableAccessHelper(this, cursorIdx, tableSchema, stmt, activeOuterCursors); }
	verifyWhereConstraints(cursorIdx: number, jumpTargetIfFalse: number): void { Helpers.verifyWhereConstraintsHelper(this, cursorIdx, jumpTargetIfFalse); }

	// Expressions
	compileExpression(expr: AST.Expression, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void { ExprCompiler.compileExpression(this, expr, targetReg, correlation, havingContext, argumentMap); }
	compileLiteral(expr: AST.LiteralExpr, targetReg: number): void { ExprCompiler.compileLiteral(this, expr, targetReg); }
	compileColumn(expr: AST.ColumnExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void { ExprCompiler.compileColumn(this, expr, targetReg, correlation, havingContext, argumentMap); }
	compileBinary(expr: AST.BinaryExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void { ExprCompiler.compileBinary(this, expr, targetReg, correlation, havingContext, argumentMap); }
	compileUnary(expr: AST.UnaryExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void { ExprCompiler.compileUnary(this, expr, targetReg, correlation, havingContext, argumentMap); }
	compileCast(expr: AST.CastExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void { ExprCompiler.compileCast(this, expr, targetReg, correlation, havingContext, argumentMap); }
	compileFunction(expr: AST.FunctionExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void { ExprCompiler.compileFunction(this, expr, targetReg, correlation, havingContext, argumentMap); }
	compileParameter(expr: AST.ParameterExpr, targetReg: number): void { ExprCompiler.compileParameter(this, expr, targetReg); }
	compileSubquery(expr: AST.SubqueryExpr, targetReg: number): void { ExprCompiler.compileSubquery(this, expr, targetReg); }
	compileScalarSubquery(subQuery: AST.SelectStmt, targetReg: number): void { ExprCompiler.compileScalarSubquery(this, subQuery, targetReg); }
	compileInSubquery(leftExpr: AST.Expression, subQuery: AST.SelectStmt, targetReg: number, invert: boolean): void { ExprCompiler.compileInSubquery(this, leftExpr, subQuery, targetReg, invert); }
	compileComparisonSubquery(leftExpr: AST.Expression, op: string, subQuery: AST.SelectStmt, targetReg: number): void { ExprCompiler.compileComparisonSubquery(this, leftExpr, op, subQuery, targetReg); }
	compileExistsSubquery(subQuery: AST.SelectStmt, targetReg: number): void { ExprCompiler.compileExistsSubquery(this, subQuery, targetReg); }

	// Statements
	compileSelect(stmt: AST.SelectStmt): void { StmtCompiler.compileSelectStatement(this, stmt); }
	compileInsert(stmt: AST.InsertStmt): void { StmtCompiler.compileInsertStatement(this, stmt); }
	compileUpdate(stmt: AST.UpdateStmt): void { StmtCompiler.compileUpdateStatement(this, stmt); }
	compileDelete(stmt: AST.DeleteStmt): void { StmtCompiler.compileDeleteStatement(this, stmt); }
	compileCreateTable(stmt: AST.CreateTableStmt): void { StmtCompiler.compileCreateTableStatement(this, stmt); }
	compileCreateVirtualTable(stmt: AST.CreateVirtualTableStmt): void { StmtCompiler.compileCreateVirtualTableStatement(this, stmt); }
	compileCreateIndex(stmt: AST.CreateIndexStmt): void { StmtCompiler.compileCreateIndexStatement(this, stmt); }
	compileCreateView(stmt: AST.CreateViewStmt): void { StmtCompiler.compileCreateViewStatement(this, stmt); }
	compileDrop(stmt: AST.DropStmt): void { StmtCompiler.compileDropStatement(this, stmt); }
	compileAlterTable(stmt: AST.AlterTableStmt): void { StmtCompiler.compileAlterTableStatement(this, stmt); }
	compileBegin(stmt: AST.BeginStmt): void { StmtCompiler.compileBeginStatement(this, stmt); }
	compileCommit(stmt: AST.CommitStmt): void { StmtCompiler.compileCommitStatement(this, stmt); }
	compileRollback(stmt: AST.RollbackStmt): void { StmtCompiler.compileRollbackStatement(this, stmt); }
	compileSavepoint(stmt: AST.SavepointStmt): void { StmtCompiler.compileSavepointStatement(this, stmt); }
	compileRelease(stmt: AST.ReleaseStmt): void { StmtCompiler.compileReleaseStatement(this, stmt); }
	compileSelectCore(stmt: AST.SelectStmt, outerCursors: number[], correlation?: SubqueryCorrelationResult, argumentMap?: ArgumentMap): { resultBaseReg: number, numCols: number, columnMap: ColumnResultInfo[] } {
		// Explicitly type the function we're calling to help the linter
		const compileFunc: (
			c: Compiler,
			s: AST.SelectStmt,
			oc: number[],
			corr?: SubqueryCorrelationResult,
			am?: ArgumentMap
		) => { resultBaseReg: number, numCols: number, columnMap: ColumnResultInfo[] } = StmtCompiler.compileSelectCoreStatement;

		return compileFunc(this, stmt, outerCursors, correlation, argumentMap);
	}
}

// Augment the Compiler interface (needed for methods in other files to see 'this')
// This duplicates the declarations in the other files, which is necessary for standalone file checks
// but might feel redundant. Alternatively, create a central interface file.
declare module './compiler' {
	interface Compiler {
		// Helpers
		allocateMemoryCells(count: number): number;
		allocateCursor(): number;
		addConstant(value: SqlValue): number;
		emit(opcode: Opcode, p1?: number, p2?: number, p3?: number, p4?: any, p5?: number, comment?: string): number;
		allocateAddress(): number;
		resolveAddress(placeholder: number): void;
		getCurrentAddress(): number;
		createEphemeralSchema(cursorIdx: number, numCols: number): TableSchema;
		closeCursorsUsedBySelect(cursors: number[]): void;
		compileFromCore(sources: AST.FromClause[] | undefined): number[];
		planTableAccess(cursorIdx: number, tableSchema: TableSchema, stmt: AST.SelectStmt | AST.UpdateStmt | AST.DeleteStmt, activeOuterCursors: ReadonlySet<number>): void;
		verifyWhereConstraints(cursorIdx: number, jumpTargetIfFalse: number): void;

		// Expressions
		compileExpression(expr: AST.Expression, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void;
		compileLiteral(expr: AST.LiteralExpr, targetReg: number): void;
		compileColumn(expr: AST.ColumnExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void;
		compileBinary(expr: AST.BinaryExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void;
		compileUnary(expr: AST.UnaryExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void;
		compileCast(expr: AST.CastExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void;
		compileFunction(expr: AST.FunctionExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void;
		compileParameter(expr: AST.ParameterExpr, targetReg: number): void;
		compileSubquery(expr: AST.SubqueryExpr, targetReg: number): void;
		compileScalarSubquery(subQuery: AST.SelectStmt, targetReg: number): void;
		compileInSubquery(leftExpr: AST.Expression, subQuery: AST.SelectStmt, targetReg: number, invert: boolean): void;
		compileComparisonSubquery(leftExpr: AST.Expression, op: string, subQuery: AST.SelectStmt, targetReg: number): void;
		compileExistsSubquery(subQuery: AST.SelectStmt, targetReg: number): void;

		// Statements
		compileSelect(stmt: AST.SelectStmt): void;
		compileInsert(stmt: AST.InsertStmt): void;
		compileUpdate(stmt: AST.UpdateStmt): void;
		compileDelete(stmt: AST.DeleteStmt): void;
		compileCreateTable(stmt: AST.CreateTableStmt): void;
		compileCreateVirtualTable(stmt: AST.CreateVirtualTableStmt): void;
		compileCreateIndex(stmt: AST.CreateIndexStmt): void;
		compileCreateView(stmt: AST.CreateViewStmt): void;
		compileDrop(stmt: AST.DropStmt): void;
		compileAlterTable(stmt: AST.AlterTableStmt): void;
		compileBegin(stmt: AST.BeginStmt): void;
		compileCommit(stmt: AST.CommitStmt): void;
		compileRollback(stmt: AST.RollbackStmt): void;
		compileSavepoint(stmt: AST.SavepointStmt): void;
		compileRelease(stmt: AST.ReleaseStmt): void;
		compileSelectCore(stmt: AST.SelectStmt, outerCursors: number[], correlation?: SubqueryCorrelationResult, argumentMap?: ArgumentMap): { resultBaseReg: number, numCols: number, columnMap: ColumnResultInfo[] };

		cursorPlanningInfo: Map<number, CursorPlanningResult>;
		tableAliases: Map<string, number>;
		subroutineDefs: Map<AST.SelectStmt, SubroutineInfo>;

		// Make compilation context switchers accessible if helpers need them
		startSubroutineCompilation(): number;
		endSubroutineCompilation(): void;

		subroutineDepth: number;
	}

	interface SubroutineInfo {
		startAddress: number;
		correlation: SubqueryCorrelationResult;
		regSubqueryHasNullOutput?: number;
	}
}
