import { SqliteError } from '../common/errors.js';
import { StatusCode, SqlDataType, ConflictResolution } from '../common/constants.js';
import { Opcode } from '../vdbe/opcodes.js';
import type { Compiler, ColumnResultInfo } from './compiler.js';
import type { TableSchema } from '../schema/table.js';
import type * as AST from '../parser/ast.js';
import type { P4SortKey } from '../vdbe/instruction.js';
import { createDefaultColumnSchema } from '../schema/column.js';
import { buildColumnIndexMap } from '../schema/table.js';
import { compileUnhandledWhereConditions } from './whereVerify.js';
import { analyzeSubqueryCorrelation } from './correlation.js';

// --- Add CTE compilation ---\
export function compileCommonTableExpression(compiler: Compiler, cte: AST.CommonTableExpr, isRecursiveContext: boolean): void {
	const cteName = cte.name.toLowerCase();
	console.log(`Compiling CTE: ${cteName}, Recursive Context: ${isRecursiveContext}`);

	// --- Recursive CTE Handling --- //
	if (isRecursiveContext && isRecursiveCteQuery(compiler, cte, cteName)) {
		console.log(`Compiling RECURSIVE CTE: ${cteName}`);
		_compileRecursiveCte(compiler, cte); // Call private helper with compiler
		return; // Handled by recursive logic
	}

	// --- Non-Recursive CTE Handling --- //
	// Check if it *looks* recursive but wasn't declared in a RECURSIVE context
	if (!isRecursiveContext && isRecursiveCteQuery(compiler, cte, cteName)) {
		throw new SqliteError(`Recursive CTE '${cteName}' used without 'RECURSIVE' keyword`, StatusCode.ERROR, undefined, cte.loc?.start.line, cte.loc?.start.column);
	}

	console.log(`Compiling Non-Recursive CTE (Materializing): ${cteName}`);
	_compileMaterializedCte(compiler, cte); // Call private helper with compiler
}

// --- Private Helper Methods for CTE Compilation --- //

function _compileMaterializedCte(compiler: Compiler, cte: AST.CommonTableExpr): void {
	const cteName = cte.name.toLowerCase();

	// 1. Determine CTE Schema and Prepare Ephemeral Table
	const savedState = _saveCompilerState(compiler, ['tableAliases', 'tableSchemas', 'ephemeralTables', 'cteMap', 'cursorPlanningInfo', 'resultColumns', 'columnAliases']);

	let cteSchema: TableSchema;
	let cteCursorIdx = -1;
	let resultInfo: { resultBaseReg: number; numCols: number; columnMap: ColumnResultInfo[] };

	try {
		if (cte.query.type === 'select') {
			const outerCursors = Array.from(savedState.tableAliases?.values() ?? []);
			// Compile just to get the schema, don't emit population code yet
			resultInfo = compiler.compileSelectCore(cte.query, outerCursors);

			cteCursorIdx = compiler.allocateCursor();
			// Use inferred column info to create a better schema if possible
			const inferredColumns = resultInfo.columnMap.map((info, index) => {
				// Basic type inference - can be improved
				let affinity = SqlDataType.TEXT;
				if (info.expr?.type === 'literal') {
					if (typeof info.expr.value === 'number') affinity = SqlDataType.REAL;
					if (typeof info.expr.value === 'bigint') affinity = SqlDataType.INTEGER;
					if (info.expr.value === null) affinity = SqlDataType.NULL; // Though usually TEXT/BLOB default is fine
				}
				// Use alias from SELECT list if available, otherwise generate name
				const name = compiler.columnAliases[resultInfo.resultBaseReg + index] ?? `cte_col_${index}`;
				return { ...createDefaultColumnSchema(name), affinity };
			});
			cteSchema = compiler.createEphemeralSchema(cteCursorIdx, resultInfo.numCols);
			// Update the created schema with inferred columns
			(cteSchema as any).columns = Object.freeze(inferredColumns);
			(cteSchema as any).columnIndexMap = Object.freeze(buildColumnIndexMap(inferredColumns));

			console.log(`CTE '${cteName}': Inferred ${resultInfo.numCols} columns for ephemeral table ${cteCursorIdx}`);
		} else {
			throw new SqliteError(`CTE query type '${cte.query.type}' not yet supported for materialization`, StatusCode.ERROR, undefined, cte.query.loc?.start.line, cte.query.loc?.start.column);
		}

	} finally {
		_restoreCompilerState(compiler, savedState);
	}

	// --- Now, generate code to populate the ephemeral table --- //
	// Add the final CTE info to the *current* compiler state
	compiler.cteMap.set(cteName, { type: 'materialized', cursorIdx: cteCursorIdx, schema: cteSchema });
	compiler.tableSchemas.set(cteCursorIdx, cteSchema);
	compiler.ephemeralTables.set(cteCursorIdx, cteSchema);

	// Open the ephemeral table for writing
	compiler.emit(Opcode.OpenWrite, cteCursorIdx, cteSchema.columns.length, 0, cteSchema, 0, `OpenWrite Ephemeral CTE '${cteName}'`);

	// --- Compile the CTE query again to generate population loop --- //
	_compileSelectAndPopulateEphemeral(compiler, cte.query as AST.SelectStmt, cteCursorIdx, cteSchema);
	// Note: We don't close the cteCursorIdx here, the main query needs it.
	console.log(`Finished compiling materialized CTE: ${cteName}`);
}

function _compileRecursiveCte(compiler: Compiler, cte: AST.CommonTableExpr): void {
	const cteName = cte.name.toLowerCase();
	if (cte.query.type !== 'select' || (!cte.query.union && !cte.query.unionAll)) {
		throw new SqliteError(`Recursive CTE '${cteName}' must use UNION or UNION ALL`, StatusCode.ERROR, undefined, cte.query.loc?.start.line, cte.query.loc?.start.column);
	}

	const initialSelect = { ...cte.query, union: undefined, unionAll: undefined }; // Extract initial SELECT
	const recursiveSelect = cte.query.union;
	if (!recursiveSelect) {
		throw new SqliteError(`Recursive CTE '${cteName}' is missing the recursive part after UNION ALL`, StatusCode.ERROR, undefined, cte.query.loc?.start.line, cte.query.loc?.start.column);
	}
	const isUnionAll = cte.query.unionAll ?? false; // Default to UNION (distinct)

	// 1. Allocate Cursors
	const resCursor = compiler.allocateCursor(); // Final results
	const queueCursor = compiler.allocateCursor(); // Work queue

	// 2. Determine Schema (from initial term)
	const savedStateSchema = _saveCompilerState(compiler, ['tableAliases', 'tableSchemas', 'ephemeralTables', 'cteMap', 'cursorPlanningInfo', 'resultColumns', 'columnAliases']);
	let cteSchema: TableSchema;
	let queueSchema: TableSchema;
	let resultInfo: { resultBaseReg: number; numCols: number; columnMap: ColumnResultInfo[] };
	try {
		resultInfo = compiler.compileSelectCore(initialSelect, Array.from(savedStateSchema.tableAliases?.values() ?? []));
		// Make Result table UNIQUE if UNION (not UNION ALL)
		const pkDef: { index: number; desc: boolean }[] = [];
		let resultSortKey: P4SortKey | undefined = undefined;
		if (!isUnionAll) {
			for (let i = 0; i < resultInfo.numCols; i++) pkDef.push({ index: i, desc: false });
			resultSortKey = { type: 'sortkey', keyIndices: pkDef.map(p => p.index), directions: pkDef.map(p => p.desc) };
			console.log(`Recursive CTE '${cteName}': Using UNION (distinct), creating PK on all columns for Result table ${resCursor}`);
		}
		cteSchema = compiler.createEphemeralSchema(resCursor, resultInfo.numCols, resultSortKey);
		queueSchema = compiler.createEphemeralSchema(queueCursor, resultInfo.numCols); // Queue doesn't need PK

		// Update schema with inferred column names/types
		const inferredColumns = resultInfo.columnMap.map((info, index) => {
			let affinity = SqlDataType.TEXT; // Default
			if (info.expr?.type === 'literal') {
				if (typeof info.expr.value === 'number') affinity = SqlDataType.REAL;
				if (typeof info.expr.value === 'bigint') affinity = SqlDataType.INTEGER;
				if (info.expr.value === null) affinity = SqlDataType.NULL;
			}
			const name = compiler.columnAliases[resultInfo.resultBaseReg + index] ?? `cte_col_${index}`;
			return { ...createDefaultColumnSchema(name), affinity };
		});
		(cteSchema as any).columns = Object.freeze(inferredColumns);
		(cteSchema as any).columnIndexMap = Object.freeze(buildColumnIndexMap(inferredColumns));
		(queueSchema as any).columns = Object.freeze(inferredColumns); // Queue needs same structure
		(queueSchema as any).columnIndexMap = Object.freeze(buildColumnIndexMap(inferredColumns));

	} finally {
		_restoreCompilerState(compiler, savedStateSchema);
	}

	// Add Result CTE to map *before* compiling terms
	compiler.cteMap.set(cteName, { type: 'materialized', cursorIdx: resCursor, schema: cteSchema });
	compiler.tableSchemas.set(resCursor, cteSchema); // Make schema available
	compiler.ephemeralTables.set(resCursor, cteSchema);
	// We don't add the queue table to the main maps, it's internal
	compiler.ephemeralTables.set(queueCursor, queueSchema); // Track ephemeral queue

	// Open Result and Queue tables for writing
	compiler.emit(Opcode.OpenWrite, resCursor, cteSchema.columns.length, 0, cteSchema, 0, `OpenWrite REC CTE Result '${cteName}'`);
	compiler.emit(Opcode.OpenWrite, queueCursor, queueSchema.columns.length, 0, queueSchema, 0, `OpenWrite REC CTE Queue '${cteName}'`);

	// 3. Compile Initial Term & Populate BOTH tables
	console.log(`REC CTE '${cteName}': Compiling initial term...`);
	_compileSelectAndPopulateEphemeral(compiler, initialSelect, resCursor, cteSchema, true, queueCursor, queueSchema, true /* Always UNION ALL into queue */);

	// 4. Recursive Loop
	console.log(`REC CTE '${cteName}': Compiling recursive loop...`);
	const addrRewindQueue = compiler.getCurrentAddress();
	const addrLoopStart = compiler.allocateAddress(); // Address after VNext Queue
	const addrLoopEnd = compiler.allocateAddress();   // Target when queue is empty

	compiler.emit(Opcode.Rewind, queueCursor, addrLoopEnd, 0, null, 0, `REC CTE: Rewind Queue`);
	compiler.resolveAddress(addrLoopStart); // Loop target
	compiler.emit(Opcode.VNext, queueCursor, addrLoopEnd, 0, null, 0, `REC CTE: VNext Queue`);

	// --- Compile Recursive Term --- //
	const loopSavedState = _saveCompilerState(compiler, ['tableAliases', 'tableSchemas', 'cteMap', 'ephemeralTables', 'cursorPlanningInfo']);
	try {
		// Temporarily map the CTE name to the QUEUE table for the recursive step
		compiler.cteMap.set(cteName, { type: 'materialized', cursorIdx: queueCursor, schema: queueSchema });
		compiler.tableAliases.set(cteName, queueCursor); // Allow direct reference
		compiler.tableSchemas.set(queueCursor, queueSchema);
		console.log(`REC CTE '${cteName}': Mapping self-reference to QUEUE cursor ${queueCursor}`);

		// Compile the recursive SELECT and generate loop to populate targets
		// Pass isUnionAll flag to handle conflict resolution during population
		_compileSelectAndPopulateEphemeral(compiler, recursiveSelect, resCursor, cteSchema, true, queueCursor, queueSchema, isUnionAll);

	} finally {
		console.log(`REC CTE '${cteName}': Restoring state after recursive step compilation.`);
		_restoreCompilerState(compiler, loopSavedState);
	}
	// --- End Compile Recursive Term --- //

	// Jump back to start of main recursive loop (before VNext Queue)
	compiler.emit(Opcode.Goto, 0, addrLoopStart, 0, null, 0, "REC CTE: Loop back");

	// 5. Finalization
	compiler.resolveAddress(addrLoopEnd);
	compiler.emit(Opcode.Close, queueCursor, 0, 0, null, 0, `Close REC CTE Queue '${cteName}'`);
	compiler.ephemeralTables.delete(queueCursor); // Clean up ephemeral tracking

	// The Result Table (resCursor) remains open and is registered in cteMap
	console.log(`Finished compiling recursive CTE: ${cteName}`);
}

function _compileSelectAndPopulateEphemeral(
	compiler: Compiler,
	selectStmt: AST.SelectStmt,
	targetCursor: number,
	targetSchema: TableSchema,
	insertIntoQueue: boolean = false,
	queueCursor?: number,
	queueSchema?: TableSchema,
	isUnionAll: boolean = true // Added flag for UNION ALL vs UNION
): void {
	// Save state, excluding CTE map (allow reading prior CTEs)
	const savedState = _saveCompilerState(compiler, ['tableAliases', 'tableSchemas', 'ephemeralTables', 'cursorPlanningInfo']);
	let queryResultBase = 0;
	let queryNumCols = 0;
	let queryCursors: number[] = [];

	try {
		// We need the *current* CTE map available when compiling the FROM clause
		queryCursors = compiler.compileFromCore(selectStmt.from);

		const outerCursorsForPlanning = new Set(Array.from(compiler.tableAliases.values()));
		queryCursors.forEach(cursor => {
			const schema = compiler.tableSchemas.get(cursor);
			if (schema) {
				compiler.planTableAccess(cursor, schema, selectStmt, outerCursorsForPlanning);
			}
		});

		const loopStarts: number[] = [];
		const loopEnds: number[] = [];
		const innermostLoopBodyStart = compiler.allocateAddress(); // Jump target *after* all VFilters
		const activeOuterCursors = new Set<number>();

		// --- Generate nested loops for the query's FROM sources --- //
		if (queryCursors.length === 0) {
			// Handle SELECT without FROM
			compiler.resolveAddress(innermostLoopBodyStart); // Directly enter body
		} else {
			queryCursors.forEach((cursor, index) => {
				const schema = compiler.tableSchemas.get(cursor);
				if (!schema) throw new Error(`Internal: Schema missing for query cursor ${cursor}`);
				const loopStartAddr = compiler.allocateAddress();
				const eofTarget = compiler.allocateAddress();
				loopStarts.push(loopStartAddr);
				loopEnds.push(eofTarget);

				const planningInfo = compiler.cursorPlanningInfo.get(cursor);
				let filterP4: any = { idxNum: 0, idxStr: null, nArgs: 0 };
				let regArgsStart = 0;
				if (planningInfo && planningInfo.idxNum !== 0) {
					const argsToCompile: { constraintIdx: number, expr: AST.Expression }[] = [];
					planningInfo.usage.forEach((usage, constraintIdx) => {
						if (usage.argvIndex > 0) {
							const expr = planningInfo.constraintExpressions?.get(constraintIdx);
							if (!expr) throw new SqliteError(`Internal error: Missing expression for constraint ${constraintIdx} used in CTE pop VFilter`, StatusCode.INTERNAL);
							while (argsToCompile.length < usage.argvIndex) { argsToCompile.push(null as any); }
							argsToCompile[usage.argvIndex - 1] = { constraintIdx, expr };
						}
					});
					const finalArgsToCompile = argsToCompile.filter(a => a !== null);
					if (finalArgsToCompile.length > 0) {
						regArgsStart = compiler.allocateMemoryCells(finalArgsToCompile.length);
						finalArgsToCompile.forEach((argInfo, i) => {
							const correlation = analyzeSubqueryCorrelation(compiler, argInfo.expr, activeOuterCursors);
							compiler.compileExpression(argInfo.expr, regArgsStart + i, correlation);
						});
					}
					filterP4 = { idxNum: planningInfo.idxNum, idxStr: planningInfo.idxStr, nArgs: finalArgsToCompile.length };
				}

				compiler.emit(Opcode.VFilter, cursor, eofTarget, regArgsStart, filterP4, 0, `Populate Ephemeral: Scan Cursor ${index}`);
				compiler.resolveAddress(loopStartAddr);
				compiler.verifyWhereConstraints(cursor, eofTarget); // Jump to VNext on fail
				activeOuterCursors.add(cursor);
				if (index === queryCursors.length - 1) {
					compiler.resolveAddress(innermostLoopBodyStart); // Mark start of body after last filter
				}
			});
		}

		// --- Innermost Loop Body --- //
		// Jump target if WHERE fails inside the innermost loop
		const innermostWhereFailTarget = compiler.allocateAddress();
		compileUnhandledWhereConditions(compiler, selectStmt.where, queryCursors, innermostWhereFailTarget);

		// Compile the SELECT expressions for the current row
		const innerResult = compiler.compileSelectCore(selectStmt, Array.from(activeOuterCursors));
		queryResultBase = innerResult.resultBaseReg;
		queryNumCols = innerResult.numCols;
		if (queryNumCols !== targetSchema.columns.length) {
			throw new SqliteError(`CTE column count mismatch during population: expected ${targetSchema.columns.length}, got ${queryNumCols}`, StatusCode.ERROR, undefined, selectStmt.loc?.start.line, selectStmt.loc?.start.column);
		}

		// Prepare data for VUpdate
		const insertDataReg = compiler.allocateMemoryCells(queryNumCols + 1);
		compiler.emit(Opcode.Null, 0, insertDataReg, 0, null, 0, "Populate Eph: Rowid=NULL");
		compiler.emit(Opcode.Move, queryResultBase, insertDataReg + 1, queryNumCols, null, 0, "Populate Eph: Copy Result");

		// Insert into Target Table
		// Use IGNORE for UNION semantics, ABORT otherwise (or for UNION ALL)
		const onConflictTarget = !isUnionAll ? ConflictResolution.IGNORE : ConflictResolution.ABORT;
		const p4UpdateTarget: any = { table: targetSchema, onConflict: onConflictTarget };
		// Need to know if the insert actually happened for queue insertion
		// Let's allocate a temp register to store the outcome (new rowid or null/error indicator)
		const regTargetRowid = compiler.allocateMemoryCells(1);
		// Set to known non-null value before VUpdate (helps debugging, VDBE will overwrite)
		compiler.emit(Opcode.Integer, -1, regTargetRowid, 0, null, 0, "Populate Eph: Init target rowid check");
		compiler.emit(Opcode.VUpdate, queryNumCols + 1, insertDataReg, regTargetRowid, p4UpdateTarget, 0, `Populate Eph: Insert Target ${targetCursor}`);

		// Insert into Queue Table if requested AND if target insert was successful (or UNION ALL)
		if (insertIntoQueue && queueCursor !== undefined && queueSchema) {
			const addrSkipQueueInsert = compiler.allocateAddress();
			if (!isUnionAll) {
				// If UNION DISTINCT, only insert into queue if the target insert was successful (regTargetRowid is NOT NULL)
				compiler.emit(Opcode.IfNull, regTargetRowid, addrSkipQueueInsert, 0, null, 0, "Populate Eph: Skip queue if target insert ignored");
			}
			// Insert into queue (always for UNION ALL, or if target insert succeeded for UNION)
			const p4UpdateQueue: any = { table: queueSchema, onConflict: ConflictResolution.ABORT }; // Queue never ignores
			compiler.emit(Opcode.VUpdate, queryNumCols + 1, insertDataReg, 0, p4UpdateQueue, 0, `Populate Eph: Insert Queue ${queueCursor}`);
			compiler.resolveAddress(addrSkipQueueInsert);
		}

		// Jump target for the inner WHERE clause failure
		compiler.resolveAddress(innermostWhereFailTarget);

		// --- Generate loop closing --- //
		if (queryCursors.length > 0) {
			for (let i = queryCursors.length - 1; i >= 0; i--) {
				const cursor = queryCursors[i];
				const loopStartAddr = loopStarts[i];
				const eofAddr = loopEnds[i];
				compiler.emit(Opcode.Goto, 0, loopStartAddr -1, 0, null, 0, `Populate Eph: Goto VNext ${i}`);
				compiler.resolveAddress(eofAddr);
				activeOuterCursors.delete(cursor);
			}
		} else {
			// If no FROM clause, this block is executed once, then finishes.
		}

	} finally {
		compiler.closeCursorsUsedBySelect(queryCursors);
		_restoreCompilerState(compiler, savedState);
	}
}

// --- Helper to save/restore specific compiler state fields --- //
function _saveCompilerState(compiler: Compiler, fields: Array<keyof Compiler>): Partial<Compiler> {
	const state: Partial<Compiler> = {};
	for (const field of fields) {
		// Simple shallow copy for maps, arrays might need deeper clone if mutated
		const currentValue = (compiler as any)[field];
		if (currentValue instanceof Map) {
			(state as any)[field] = new Map(currentValue as any);
		} else if (Array.isArray(currentValue)) {
			(state as any)[field] = [...(currentValue as any)];
		} else {
			// Handle other types if necessary (like primitive counters?)
			(state as any)[field] = currentValue;
		}
	}
	return state;
}

function _restoreCompilerState(compiler: Compiler, savedState: Partial<Compiler>): void {
	for (const field in savedState) {
		if (Object.prototype.hasOwnProperty.call(savedState, field)) {
			(compiler as any)[field] = (savedState as any)[field];
		}
	}
}

// --- Helper Function (can go in helpers.ts later) ---
function isRecursiveCteQuery(compiler: Compiler, cte: AST.CommonTableExpr, cteName: string): boolean {
	if (cte.query.type !== 'select') return false;
	const sel = cte.query as AST.SelectStmt;
	// Check the recursive part of a UNION/UNION ALL query
	if (sel.union) {
		const checkClause = (clause: AST.FromClause): boolean => {
			if (!clause) return false;
			if (clause.type === 'table') {
				// Need to check against CTE name, not compiler.tableAliases during initial check
				if (clause.table.name.toLowerCase() === cteName.toLowerCase()) {
					return true;
				}
			} else if (clause.type === 'join') {
				return checkClause(clause.left) || checkClause(clause.right);
			}
			// Add other FROM clause types if needed (e.g., subqueries, functions)
			// Important: Subqueries need careful scope checking here. Assume non-recursive for now.
			return false;
		};
		// Check if the recursive select statement's FROM clause references the CTE
		return sel.union.from?.some(checkClause) ?? false;
	}
	return false;
}
