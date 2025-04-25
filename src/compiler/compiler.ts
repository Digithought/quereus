/**
 * SQL Compiler for SQLiter
 *
 * Translates SQL AST into VDBE instructions
 */
import { StatusCode, type SqlValue } from '../common/types';
import { SqliteError, ParseError } from '../common/errors';
import { ConflictResolution } from '../common/constants';
import { Opcode } from '../vdbe/opcodes';
import { type P4SortKey, type VdbeInstruction, createInstruction } from '../vdbe/instruction';
import type { VdbeProgram } from '../vdbe/program';
import type { WithClause } from '../parser/ast';
import type { Database } from '../core/database';
import type { TableSchema } from '../schema/table';
import type * as AST from '../parser/ast';
import * as CompilerState from './compilerState';
import * as EphemeralCore from './ephemeral';
import * as FromClauseCore from './fromClause';
import * as QueryPlanner from './queryPlanner';
import * as WhereVerify from './whereVerify';
import * as ExprHandlers from './handlers';
import { compileExpression } from './expression';
import * as StmtCompiler from './statement';
import * as DdlCompiler from './ddl';
import * as SelectCompiler from './select';
import * as Utils from './utils';
import type { SubqueryCorrelationResult } from './correlation';
import * as SubqueryCompiler from './subquery';
import type { ArgumentMap } from './handlers';
import { compileCommonTableExpression } from './cte';
import type { IndexConstraint, IndexConstraintUsage } from '../vtab/indexInfo';

// --- Add Result/CTE Info types --- //
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
	// Add 'view' type later if needed
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
// ---------------------------------- //

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
	// --- Add CTE map --- //
	public cteMap: Map<string, CteInfo> = new Map(); // Map CTE name -> Info
	// -------------------- //
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
	// --- Stack Pointers ---
	public stackPointer: number = 0; // Current stack top (absolute index)
	public framePointer: number = 0; // Current frame base (absolute index)
	// ----------------------
	public outerCursors: number[] = []; // Added property

	constructor(db: Database) {
		this.db = db;
	}

	/**
	 * Compile an AST node into a VDBE program
	 */
	compile(ast: AST.AstNode, sql: string): VdbeProgram {
		try {
			// Reset state
			this.sql = sql;
			this.constants = [];
			// Reset main instruction stream (subroutines handled separately)
			this.instructions = [];
			this.numMemCells = 0;
			this.numCursors = 0;
			this.parameters = new Map();
			this.columnAliases = [];
			this.cteMap = new Map(); // Reset CTE map
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
			this.stackPointer = 0; // Reset stack pointers
			this.framePointer = 0;
			this.outerCursors = []; // Initialize outerCursors
			// -----------------------------

			// Add initial Init instruction
			this.emit(Opcode.Init, 0, 1, 0, null, 0, "Start of program"); // Start PC=1

			// --- Compile WITH clause FIRST if present --- //
			let withClause: WithClause | undefined;
			if ('withClause' in ast && (ast as any).withClause !== undefined) {
				withClause = (ast as any).withClause;
				this.compileWithClause(withClause);
			}
			// ------------------------------------------ //

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
				// --- Add WITH clause handling for other statements if needed --- //
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

			// --- Append subroutines after main program --- //
			if (this.subroutineCode.length > 0) {
				// Patch subroutine FrameEnter sizes before appending
				// (This assumes endSubroutineCompilation was called correctly for each)
				this.instructions.push(...this.subroutineCode);
				this.subroutineCode = []; // Clear for potential reuse
			}
			// -------------------------------------------- //

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
					error.message, // Original parser message (already includes location hint from token)
					StatusCode.ERROR, // Use the correct code
					error, // Set the original ParseError as the cause
					error.line, // Use line from SqliteError base
					error.column // Use column from SqliteError base
				);
			} else if (error instanceof SqliteError) {
				// If it's already an SqliteError, just re-throw it
				throw error;
			} else {
				// Wrap other unexpected errors
				throw new SqliteError(
					`Unexpected compiler error: ${error instanceof Error ? error.message : String(error)}`,
					StatusCode.INTERNAL,
					error instanceof Error ? error : undefined // Set cause if it's an Error
				);
			}
		}
	}

	// --- Update Subroutine Compilation Context --- //
	startSubroutineCompilation(): number { // Return address of FrameEnter
		this.subroutineDepth++;
		// Reset tracking for the new frame
		this.maxLocalOffsetInCurrentFrame = 0;
		// Emit FrameEnter with placeholder size (0). Will be patched in endSubroutineCompilation.
		// Target the subroutineCode array directly for emission
		const instruction = createInstruction(Opcode.FrameEnter, 0, 0, 0, null, 0, `Enter Subroutine Frame Depth ${this.subroutineDepth}`);
		this.subroutineCode.push(instruction);
		const frameEnterAddr = this.subroutineCode.length - 1; // Address relative to subroutineCode
		this.currentFrameEnterInsn = instruction; // Get ref
		// Reserve space for control info (RetAddr, OldFP) - Frame slots 0 and 1
		// allocateMemoryCellsHelper handles offsets correctly within the frame logic
		return frameEnterAddr;
	}

	endSubroutineCompilation(): void {
		if (this.subroutineDepth > 0) {
			// Patch the FrameEnter instruction with the calculated frame size
			if (this.currentFrameEnterInsn) {
				// Frame size = max local offset used + 1 (since offset is 0-based)
				// Local offsets start at 2, so max offset includes control info slots
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

	// --- Wrapper Methods Delegating to Helpers --- //

	// Compiler State Helpers (./core/compilerState)
	allocateMemoryCells(count: number): number { return CompilerState.allocateMemoryCellsHelper(this, count); }
	allocateCursor(): number { return CompilerState.allocateCursorHelper(this); }
	addConstant(value: SqlValue): number { return CompilerState.addConstantHelper(this, value); }
	emit(opcode: Opcode, p1?: number, p2?: number, p3?: number, p4?: any, p5?: number, comment?: string): number { return CompilerState.emitInstruction(this, opcode, p1, p2, p3, p4, p5, comment); }
	allocateAddress(): number { return CompilerState.allocateAddressHelper(this); }
	resolveAddress(placeholder: number): void { CompilerState.resolveAddressHelper(this, placeholder); }
	getCurrentAddress(): number { return CompilerState.getCurrentAddressHelper(this); }

	// Ephemeral Table Helpers (./core/ephemeral)
	createEphemeralSchema(cursorIdx: number, numCols: number, sortKey?: P4SortKey): TableSchema { return EphemeralCore.createEphemeralSchemaHelper(this, cursorIdx, numCols, sortKey); }
	closeCursorsUsedBySelect(cursors: number[]): void { EphemeralCore.closeCursorsUsedBySelectHelper(this, cursors); }

	// FROM Clause Helper (./core/fromClause)
	compileFromCore(sources: AST.FromClause[] | undefined): number[] { return FromClauseCore.compileFromCoreHelper(this, sources); }

	// Query Planning Helpers (./planning/queryPlanner & ./planning/whereVerify)
	planTableAccess(cursorIdx: number, tableSchema: TableSchema, stmt: AST.SelectStmt | AST.UpdateStmt | AST.DeleteStmt, activeOuterCursors: ReadonlySet<number>): void { QueryPlanner.planTableAccessHelper(this, cursorIdx, tableSchema, stmt, activeOuterCursors); }
	verifyWhereConstraints(cursorIdx: number, jumpTargetIfFalse: number): void { WhereVerify.verifyWhereConstraintsHelper(this, cursorIdx, jumpTargetIfFalse); }
	// compileUnhandledWhereConditions is likely called directly where needed, not via compiler instance

	// Expressions (Main dispatcher in ./expression, specific handlers in ./expression/handlers)
	// Keep the main compileExpression delegation
	compileExpression(expr: AST.Expression, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void { compileExpression(this, expr, targetReg, correlation, havingContext, argumentMap); }
	// Delegate specific handlers directly if needed (though maybe not necessary if compileExpression handles all)
	compileLiteral(expr: AST.LiteralExpr, targetReg: number): void { Utils.compileLiteralValue(this, expr.value, targetReg); }
	compileColumn(expr: AST.ColumnExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void { ExprHandlers.compileColumn(this, expr, targetReg, correlation, havingContext, argumentMap); }
	compileBinary(expr: AST.BinaryExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void { ExprHandlers.compileBinary(this, expr, targetReg, correlation, havingContext, argumentMap); }
	compileUnary(expr: AST.UnaryExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void { ExprHandlers.compileUnary(this, expr, targetReg, correlation, havingContext, argumentMap); }
	compileCast(expr: AST.CastExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void { ExprHandlers.compileCast(this, expr, targetReg, correlation, havingContext, argumentMap); }
	compileCollate(expr: AST.CollateExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void { ExprHandlers.compileCollate(this, expr, targetReg, correlation, havingContext, argumentMap); }
	compileFunction(expr: AST.FunctionExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void { ExprHandlers.compileFunction(this, expr, targetReg, correlation, havingContext, argumentMap); }
	compileParameter(expr: AST.ParameterExpr, targetReg: number): void { ExprHandlers.compileParameter(this, expr, targetReg); }

	// Subqueries (Delegated to SubqueryCompiler module)
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
		// Note: Changed name of outerCursors param to avoid conflict with class property
		return SelectCompiler.compileSelectCoreStatement(this, stmt, outerCursorsForSelect, correlation, argumentMap);
	}

	// --- Add WithClause handling ---
	compileWithClause(withClause: WithClause | undefined): void {
		if (!withClause) {
			return; // No WITH clause present
		}

		console.log(`Compiling WITH${withClause.recursive ? ' RECURSIVE' : ''} clause...`);

		// Need to handle potential mutual recursion or dependencies
		// For now, compile sequentially
		for (const cte of withClause.ctes) {
			const cteNameLower = cte.name.toLowerCase();
			if (this.cteMap.has(cteNameLower)) {
				throw new SqliteError(`Duplicate CTE name: '${cte.name}'`, StatusCode.ERROR);
			}
			// Pass the context (recursive or not) from the main WITH clause
			// Call the imported function, passing `this` (the compiler instance)
			compileCommonTableExpression(this, cte, withClause.recursive);
		}
		console.log("Finished compiling WITH clause.");
	}

	// Add compilePragma delegator
	compilePragma(stmt: AST.PragmaStmt): void { DdlCompiler.compilePragmaStatement(this, stmt); }
}

// Remove augmentations for methods moved to helper modules
// Keep augmentations for methods still delegated or part of core class interface if needed
// Ideally, this block becomes smaller or disappears with better typing/imports.
// Removing most helper declarations as they are now imported directly or handled via main dispatchers.
declare module './compiler' {
	interface Compiler {
		// Core properties are implicitly part of the interface
		// Core methods
		compile(ast: AST.AstNode, sql: string): VdbeProgram;
		startSubroutineCompilation(): number;
		endSubroutineCompilation(): void;

		// --- Keep Delegated Methods Signatures ---
		// (TypeScript needs these if methods are called via `compiler.methodName` elsewhere)
		// Compiler State
		allocateMemoryCells(count: number): number;
		allocateCursor(): number;
		addConstant(value: SqlValue): number;
		emit(opcode: Opcode, p1?: number, p2?: number, p3?: number, p4?: any, p5?: number, comment?: string): number;
		allocateAddress(): number;
		resolveAddress(placeholder: number): void;
		getCurrentAddress(): number;
		// Ephemeral
		createEphemeralSchema(cursorIdx: number, numCols: number, sortKey?: P4SortKey): TableSchema;
		closeCursorsUsedBySelect(cursors: number[]): void;
		// FROM Clause
		compileFromCore(sources: AST.FromClause[] | undefined): number[];
		// Planning
		planTableAccess(cursorIdx: number, tableSchema: TableSchema, stmt: AST.SelectStmt | AST.UpdateStmt | AST.DeleteStmt, activeOuterCursors: ReadonlySet<number>): void;
		verifyWhereConstraints(cursorIdx: number, jumpTargetIfFalse: number): void;
		// Expressions (Main dispatcher)
		compileExpression(expr: AST.Expression, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void;
		// Keep specific expression handlers if they might be called directly externally via compiler instance
		compileLiteral(expr: AST.LiteralExpr, targetReg: number): void;
		compileColumn(expr: AST.ColumnExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void;
		compileBinary(expr: AST.BinaryExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void;
		compileUnary(expr: AST.UnaryExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void;
		compileCast(expr: AST.CastExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void;
		compileCollate(expr: AST.CollateExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void;
		compileFunction(expr: AST.FunctionExpr, targetReg: number, correlation?: SubqueryCorrelationResult, havingContext?: HavingContext, argumentMap?: ArgumentMap): void;
		compileParameter(expr: AST.ParameterExpr, targetReg: number): void;
		// Subqueries
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
		compileCreateIndex(stmt: AST.CreateIndexStmt): void;
		compileCreateView(stmt: AST.CreateViewStmt): void;
		compileDrop(stmt: AST.DropStmt): void;
		compileAlterTable(stmt: AST.AlterTableStmt): void;
		compileBegin(stmt: AST.BeginStmt): void;
		compileCommit(stmt: AST.CommitStmt): void;
		compileRollback(stmt: AST.RollbackStmt): void;
		compileSavepoint(stmt: AST.SavepointStmt): void;
		compileRelease(stmt: AST.ReleaseStmt): void;
		compileSelectCore(stmt: AST.SelectStmt, outerCursorsForSelect: number[], correlation?: SubqueryCorrelationResult, argumentMap?: ArgumentMap): { resultBaseReg: number, numCols: number, columnMap: ColumnResultInfo[] };
		// CTE / Pragma
		compileWithClause(withClause: WithClause | undefined): void;
		compilePragma(stmt: AST.PragmaStmt): void;

		// Keep essential public properties needed by augmented methods/helpers
		cursorPlanningInfo: Map<number, CursorPlanningResult>;
		tableAliases: Map<string, number>;
		subroutineDefs: Map<AST.SelectStmt, SubroutineInfo>;
		subroutineDepth: number;
		stackPointer: number;
		framePointer: number;
		outerCursors: number[];
		tableSchemas: Map<number, TableSchema>; // Needed by many helpers
		ephemeralTables: Map<number, TableSchema>; // Needed by some helpers
		db: Database;
		constants: SqlValue[];
		instructions: VdbeInstruction[];
		numMemCells: number;
		numCursors: number;
		parameters: Map<number | string, { memIdx: number }>;
		columnAliases: string[];
		cteMap: Map<string, CteInfo>;
		resultColumns: { name: string, table?: string, expr?: AST.Expression }[];
	}
}
