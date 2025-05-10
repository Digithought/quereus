import { SqliterError } from '../common/errors.js';
import { StatusCode, SqlDataType } from '../common/types.js';
import { ConflictResolution } from '../common/constants.js';
import { Opcode } from '../vdbe/opcodes.js';
import type { Compiler } from './compiler.js';
import type { ColumnResultInfo, CteInfo } from './structs.js';
import type { TableSchema } from '../schema/table.js';
import type * as AST from '../parser/ast.js';
import type { P4SortKey } from '../vdbe/instruction.js';
import { createDefaultColumnSchema } from '../schema/column.js';
import { buildColumnIndexMap } from '../schema/table.js';
import { compileUnhandledWhereConditions } from './where-verify.js';
import { analyzeSubqueryCorrelation } from './correlation.js';
import { createLogger } from '../common/logger.js';
import type { IndexConstraintUsage } from '../vtab/indexInfo.js';

const log = createLogger('compiler:cte');

export function compileWithClauseHelper(compiler: Compiler, withClause: AST.WithClause): void {
	for (const cte of withClause.ctes) {
		const cteName = cte.name.toLowerCase();
		const refCount = compiler.cteReferenceCounts.get(cteName) ?? 0;
		const isRecursive = withClause.recursive;

		// Determine materialization strategy based on reference count
		let strategy: CteInfo['strategy'];
		if (cte.materializationHint === 'materialized') {
			strategy = 'materialized';
		} else if (cte.materializationHint === 'not_materialized') {
			strategy = 'view';
		} else if (isRecursive) {
			strategy = 'materialized'; // Recursive must be materialized
		} else if (refCount > 1) {
			strategy = 'materialized'; // Materialize if used more than once
		} else {
			strategy = 'view'; // Default to view (inline-like)
		}

		// Store basic info in the map first
		const cteInfo: CteInfo = {
			node: cte,
			strategy: strategy,
			// Other fields (cursorIdx, schema) will be added if materialized
		};
		compiler.cteMap.set(cteName, cteInfo);

		// Only compile materialized CTEs now
		if (strategy === 'materialized') {
			compileCommonTableExpression(compiler, cteInfo, isRecursive);
		}
	}
}
// --- Updated signature to accept CteInfo --- //
export function compileCommonTableExpression(compiler: Compiler, cteInfo: CteInfo, isRecursive: boolean): void {
	const cte = cteInfo.node; // Get the AST node from CteInfo
	const cteName = cte.name.toLowerCase();
	log(`Compiling MATERIALIZED CTE: %s, Recursive: %s`, cteName, isRecursive);

	// The decision to materialize (and check for recursive misuse) is now done in compileWithClause.
	// We only compile if the strategy is 'materialized'.
	if (cteInfo.strategy !== 'materialized') {
		throw new Error(`Internal: compileCommonTableExpression called for non-materialized CTE '${cteName}'`);
	}

	// --- Recursive CTE Handling --- //
	if (isRecursive) {
		log(`Compiling RECURSIVE CTE: %s`, cteName);
		// Pass the CteInfo object down
		_compileRecursiveCte(compiler, cteInfo);
		return;
	}

	// --- Non-Recursive CTE Handling --- //
	log(`Compiling Non-Recursive Materialized CTE: %s`, cteName);
	// Pass the CteInfo object down
	_compileMaterializedCte(compiler, cteInfo);
}

// --- Private Helper Methods for CTE Compilation --- //

// Updated signature
function _compileMaterializedCte(compiler: Compiler, cteInfo: CteInfo): void {
	const cte = cteInfo.node;
	const cteName = cte.name.toLowerCase();

	// 1. Determine CTE Schema using a dry run of compileSelectCore
	// State saving/restoring remains the same for this part
	const savedState = _saveCompilerState(compiler, ['tableAliases', 'tableSchemas', 'ephemeralTableInstances', 'cteMap', 'cursorPlanningInfo', 'resultColumns', 'columnAliases']);
	let cteCursorIdx = -1; // Will be allocated by createEphemeralSchemaHelper
	let cteSchema: TableSchema; // Will be returned by createEphemeralSchemaHelper
	let resultInfo: { resultBaseReg: number; numCols: number; columnMap: ColumnResultInfo[] };

	try {
		if (cte.query.type === 'select') {
			const outerCursors = Array.from(savedState.tableAliases?.values() ?? []);
			// Compile just to get column structure info
			resultInfo = compiler.getSelectCoreStructure(cte.query, outerCursors);

			// Create the ephemeral table *instance* and get its schema
			cteCursorIdx = compiler.allocateCursor();
			cteSchema = compiler.createEphemeralSchema(cteCursorIdx, resultInfo.numCols); // Use createEphemeralSchema (wrapper)

			// Overwrite schema columns based on inferred info (optional refinement)
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
			// Note: Schema updates might be tricky if it's frozen. For now, assume the default names are okay.
			// We're using a more sophisticated instance creation approach now, schema modification should be handled
			// by the ephemeral table helper.

			log(`CTE '%s': Created ephemeral table instance %d with %d columns.`, cteName, cteCursorIdx, resultInfo.numCols);
		} else {
			throw new SqliterError(`CTE query type '${cte.query.type}' not yet supported for materialization`, StatusCode.ERROR, undefined, cte.query.loc?.start.line, cte.query.loc?.start.column);
		}

	} finally {
		_restoreCompilerState(compiler, savedState);
	}

	// --- Now, generate code to populate the ephemeral table --- //
	// Retrieve the existing CteInfo from the map and update it
	const existingCteInfo = compiler.cteMap.get(cteName);
	if (!existingCteInfo) {
		// This shouldn't happen if called from compileWithClause
		throw new SqliterError(`Internal: CteInfo not found for '${cteName}' during materialization.`, StatusCode.INTERNAL);
	}
	// Update the existing CteInfo object with materialization details
	existingCteInfo.cursorIdx = cteCursorIdx;
	existingCteInfo.schema = cteSchema;
	// compiler.cteMap.set(cteName, { type: 'materialized', cursorIdx: cteCursorIdx, schema: cteSchema }); // OLD
	// tableSchemas and ephemeralTableInstances are already updated by createEphemeralSchemaHelper

	// Open the ephemeral table for writing using its cursor index.
	// The VDBE handler for OpenWrite needs to check if the cursor index corresponds
	// to an ephemeral instance in compiler.ephemeralTableInstances and use it.
	// Pass the schema in P4 as before.
	compiler.emit(Opcode.OpenWrite, cteCursorIdx, 0, 0, cteSchema, 0, `OpenWrite Ephemeral CTE '${cteName}'`);

	// --- Compile the CTE query again to generate population loop --- //
	_compileSelectAndPopulateEphemeral(compiler, cte.query as AST.SelectStmt, cteCursorIdx, cteSchema);
	// Note: We don't close the cteCursorIdx here, the main query needs it.
	log(`Finished compiling materialized CTE: %s`, cteName);
}

// Updated signature
function _compileRecursiveCte(compiler: Compiler, cteInfo: CteInfo): void {
	const cte = cteInfo.node;
	const cteName = cte.name.toLowerCase();
	if (cte.query.type !== 'select' || (!cte.query.union && !cte.query.unionAll)) {
		throw new SqliterError(`Recursive CTE '${cteName}' must use UNION or UNION ALL`, StatusCode.ERROR, undefined, cte.query.loc?.start.line, cte.query.loc?.start.column);
	}

	const initialSelect = { ...cte.query, union: undefined, unionAll: undefined }; // Extract initial SELECT
	const recursiveSelect = cte.query.union;
	if (!recursiveSelect) {
		throw new SqliterError(`Recursive CTE '${cteName}' is missing the recursive part after UNION ALL`, StatusCode.ERROR, undefined, cte.query.loc?.start.line, cte.query.loc?.start.column);
	}
	const isUnionAll = cte.query.unionAll ?? false; // Default to UNION (distinct)

	// 1. Allocate Cursors (Conceptual, helper will manage actual indices)
	// We need two ephemeral tables: result and queue
	let resCursor = compiler.allocateCursor();
	let queueCursor = compiler.allocateCursor();

	// 2. Determine Schema (from initial term)
	const savedStateSchema = _saveCompilerState(compiler, ['tableAliases', 'tableSchemas', 'ephemeralTableInstances', 'cteMap', 'cursorPlanningInfo', 'resultColumns', 'columnAliases']);
	let cteSchema: TableSchema; // Result schema
	let queueSchema: TableSchema; // Queue schema
	let resultInfo: { resultBaseReg: number; numCols: number; columnMap: ColumnResultInfo[] };
	try {
		resultInfo = compiler.getSelectCoreStructure(initialSelect, Array.from(savedStateSchema.tableAliases?.values() ?? []));
		const numCols = resultInfo.numCols;

		// Determine sort key for result table if UNION (distinct)
		let resultSortKey: P4SortKey | undefined = undefined;
		if (!isUnionAll) {
			const pkDef = Array.from({ length: numCols }, (_, i) => ({ index: i, desc: false }));
			resultSortKey = { type: 'sortkey', keyIndices: pkDef.map(p => p.index), directions: pkDef.map(p => p.desc) };
			log(`Recursive CTE '%s': Using UNION (distinct), creating PK on all cols for Result table`, cteName);
		}

		// Create ephemeral tables using the helper
		cteSchema = compiler.createEphemeralSchema(resCursor, numCols, resultSortKey);
		queueSchema = compiler.createEphemeralSchema(queueCursor, numCols); // Queue doesn't need unique PK from MemoryTable perspective

		// Update schema with inferred column names/types (optional refinement)
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

		log(`REC CTE '%s': Created Result instance %d, Queue instance %d`, cteName, resCursor, queueCursor);

	} finally {
		_restoreCompilerState(compiler, savedStateSchema);
	}

	// Update the existing CteInfo in the map with materialization details
	// Add Result CTE to map *before* compiling terms
	const existingCteInfo = compiler.cteMap.get(cteName);
	if (!existingCteInfo) {
		// This shouldn't happen if called from compileWithClause
		throw new SqliterError(`Internal: CteInfo not found for '${cteName}' during recursive materialization.`, StatusCode.INTERNAL);
	}
	existingCteInfo.cursorIdx = resCursor; // Result table cursor
	existingCteInfo.schema = cteSchema;
	// compiler.cteMap.set(cteName, { type: 'materialized', cursorIdx: resCursor, schema: cteSchema }); // OLD
	// tableSchemas and ephemeralTableInstances updated by helpers

	// Open Result and Queue tables for writing
	// Pass the schema in P4. VDBE OpenWrite handler links cursor index to instance.
	compiler.emit(Opcode.OpenWrite, resCursor, 0, 0, cteSchema, 0, `OpenWrite REC CTE Result '${cteName}'`);
	compiler.emit(Opcode.OpenWrite, queueCursor, 0, 0, queueSchema, 0, `OpenWrite REC CTE Queue '${cteName}'`);

	// 3. Compile Initial Term & Populate BOTH tables
	log(`REC CTE '%s': Compiling initial term...`, cteName);
	// _compileSelectAndPopulateEphemeral needs to correctly use VUpdate with the cursor index
	_compileSelectAndPopulateEphemeral(compiler, initialSelect, resCursor, cteSchema, true, queueCursor, queueSchema, true /* Always UNION ALL into queue */);

	// 4. Recursive Loop
	log(`REC CTE '%s': Compiling recursive loop...`, cteName);
	const addrLoopStart = compiler.allocateAddress();
	const addrLoopEnd = compiler.allocateAddress();
	const addrLoopBodyStart = compiler.allocateAddress();

	// Use Rewind/VNext on the queueCursor index
	compiler.emit(Opcode.Rewind, queueCursor, addrLoopEnd, 0, null, 0, `REC CTE: Rewind Queue`);
	compiler.resolveAddress(addrLoopStart);
	compiler.emit(Opcode.VNext, queueCursor, addrLoopBodyStart, addrLoopEnd, null, 0, `REC CTE: VNext Queue`);
	compiler.resolveAddress(addrLoopBodyStart);

	// --- Compile Recursive Term ---
	const loopSavedState = _saveCompilerState(compiler, ['tableAliases', 'tableSchemas', 'cteMap', 'ephemeralTableInstances', 'cursorPlanningInfo']);
	try {
		// Temporarily map the CTE name to the QUEUE table for the recursive step
		// Create a *temporary* CteInfo for the recursive step referencing the queue
		const recursiveStepCteInfo: CteInfo = {
			strategy: 'materialized', // Still materialized conceptually for this step
			node: cte, // Same AST node
			cursorIdx: queueCursor,
			schema: queueSchema
		};
		compiler.cteMap.set(cteName, recursiveStepCteInfo);
		// compiler.cteMap.set(cteName, { type: 'materialized', cursorIdx: queueCursor, schema: queueSchema }); // OLD
		compiler.tableAliases.set(cteName, queueCursor); // Allow direct reference
		// compiler.tableSchemas already set for queueCursor by helper
		log(`REC CTE '%s': Mapping self-reference to QUEUE cursor %d`, cteName, queueCursor);

		// Compile the recursive SELECT and generate loop to populate targets
		// Pass isUnionAll flag to handle conflict resolution during population
		_compileSelectAndPopulateEphemeral(compiler, recursiveSelect, resCursor, cteSchema, true, queueCursor, queueSchema, isUnionAll);

	} finally {
		log(`REC CTE '%s': Restoring state after recursive step compilation.`, cteName);
		_restoreCompilerState(compiler, loopSavedState);
	}
	// --- End Compile Recursive Term --- //

	// Jump back to start of main recursive loop (before VNext Queue)
	compiler.emit(Opcode.Goto, 0, addrLoopStart, 0, null, 0, "REC CTE: Loop back");

	// 5. Finalization
	compiler.resolveAddress(addrLoopEnd);
	// Use Close opcode with the cursor index
	compiler.emit(Opcode.Close, queueCursor, 0, 0, null, 0, `Close REC CTE Queue '${cteName}'`);
	// Cleanup helper will remove the instance from the map
	// compiler.ephemeralTableInstances.delete(queueCursor); // Now handled by closeCursorsUsedBySelectHelper

	// The Result Table (resCursor) remains open and is registered in cteMap
	// (The restoreCompilerState in the finally block above put the *original* CteInfo back in the map)
	log(`Finished compiling recursive CTE: %s`, cteName);
}

function _compileSelectAndPopulateEphemeral(
	compiler: Compiler,
	selectStmt: AST.SelectStmt,
	targetCursor: number, // Index for the target ephemeral table (result or queue)
	targetSchema: TableSchema,
	insertIntoQueue: boolean = false,
	queueCursor?: number, // Index for the queue ephemeral table
	queueSchema?: TableSchema,
	isUnionAll: boolean = true
): void {
	// Save state, excluding CTE map (allow reading prior CTEs) and instance map
	const savedState = _saveCompilerState(compiler, ['tableAliases', 'tableSchemas', 'cursorPlanningInfo']);
	let queryResultBase = 0;
	let queryNumCols = 0;
	let queryCursors: number[] = [];

	try {
		// We need the *current* CTE map available when compiling the FROM clause
		queryCursors = compiler.compileFromCore(selectStmt.from);

		// Plan table access for each cursor
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
				if (!schema) throw new Error(`Internal: Schema not found for query cursor ${cursor}`);
				const loopStartAddr = compiler.allocateAddress();
				const eofTarget = compiler.allocateAddress();
				loopStarts.push(loopStartAddr);
				loopEnds.push(eofTarget);

				const planningInfo = compiler.cursorPlanningInfo.get(cursor);
				let filterP4: any = { idxNum: 0, idxStr: null, nArgs: 0 };
				let regArgsStart = 0;
				if (planningInfo && planningInfo.idxNum !== 0) {
					const argsToCompile: { constraintIdx: number, expr: AST.Expression }[] = [];
					planningInfo.usage.forEach((usage: IndexConstraintUsage, constraintIdx: number) => {
						if (usage.argvIndex > 0) {
							const expr = planningInfo.constraintExpressions?.get(constraintIdx);
							if (!expr) throw new SqliterError(`Internal error: Missing expression for constraint ${constraintIdx} used in CTE pop VFilter`, StatusCode.INTERNAL);
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
		const innerResult = compiler.getSelectCoreStructure(selectStmt, Array.from(activeOuterCursors));
		queryResultBase = innerResult.resultBaseReg;
		queryNumCols = innerResult.numCols;
		if (queryNumCols !== targetSchema.columns.length) {
			throw new SqliterError(`CTE column count mismatch during population: expected ${targetSchema.columns.length}, got ${queryNumCols}`, StatusCode.ERROR, undefined, selectStmt.loc?.start.line, selectStmt.loc?.start.column);
		}

		// Prepare data for VUpdate
		const insertDataReg = compiler.allocateMemoryCells(queryNumCols + 1);
		compiler.emit(Opcode.Null, 0, insertDataReg, 0, null, 0, "Populate Eph: Rowid=NULL");
		compiler.emit(Opcode.Move, queryResultBase, insertDataReg + 1, queryNumCols, null, 0, "Populate Eph: Copy Result");

		// Insert into Target Table
		// Use IGNORE for UNION semantics, ABORT otherwise (or for UNION ALL)
		const onConflictTarget = !isUnionAll ? ConflictResolution.IGNORE : ConflictResolution.ABORT;
		// Pass the targetSchema in P4, VDBE handler uses it.
		// **Crucially, pass the targetCursor index in P5** so the VDBE handler can find the correct VTab instance.
		const p4UpdateTarget: any = { table: targetSchema, onConflict: onConflictTarget };
		// Need to know if the insert actually happened for queue insertion
		// Let's allocate a temp register to store the outcome (new rowid or null/error indicator)
		const regTargetRowid = compiler.allocateMemoryCells(1);
		// Set to known non-null value before VUpdate (helps debugging, VDBE will overwrite)
		compiler.emit(Opcode.Integer, -1, regTargetRowid, 0, null, 0, "Populate Eph: Init target rowid check");
		compiler.emit(Opcode.VUpdate, queryNumCols + 1, insertDataReg, regTargetRowid, p4UpdateTarget, targetCursor, `Populate Eph: Insert Target ${targetCursor}`);

		// Insert into Queue Table if requested AND if target insert was successful (or UNION ALL)
		if (insertIntoQueue && queueCursor !== undefined && queueSchema) {
			const addrSkipQueueInsert = compiler.allocateAddress();
			if (!isUnionAll) {
				// If UNION DISTINCT, only insert into queue if the target insert was successful (regTargetRowid is NOT NULL)
				compiler.emit(Opcode.IfNull, regTargetRowid, addrSkipQueueInsert, 0, null, 0, "Populate Eph: Skip queue if target insert ignored");
			}
			// Insert into queue (always for UNION ALL, or if target insert succeeded for UNION)
			const p4UpdateQueue: any = { table: queueSchema, onConflict: ConflictResolution.ABORT }; // Queue never ignores
			// **Pass the queueCursor index in P5**
			compiler.emit(Opcode.VUpdate, queryNumCols + 1, insertDataReg, 0, p4UpdateQueue, queueCursor, `Populate Eph: Insert Queue ${queueCursor}`);
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
				compiler.emit(Opcode.Goto, 0, loopStartAddr, 0, null, 0, `Populate Eph: Goto VNext ${i}`);
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
		// Handle ephemeralTableInstances map specifically
		if (field === 'ephemeralTableInstances') {
			// Shallow copy is sufficient as we don't modify the instances themselves here
			(state as any)[field] = new Map((compiler as any)[field] as Map<number, any>);
		} else {
			// Existing logic for other types
			const currentValue = (compiler as any)[field];
			if (currentValue instanceof Map) {
				(state as any)[field] = new Map(currentValue as any);
			} else if (Array.isArray(currentValue)) {
				(state as any)[field] = [...(currentValue as any)];
			} else {
				(state as any)[field] = currentValue;
			}
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
/* MOVED to compiler.ts
function isRecursiveCteQuery(compiler: Compiler, cte: AST.CommonTableExpr, cteName: string): boolean {
	if (cte.query.type !== 'select') return false;
    // ... implementation ...
	return false;
}
*/
