import { Opcode, IndexConstraintOp } from '../common/constants';
import type { SqlValue } from '../common/types';
import { SqliteError } from '../common/errors';
import { StatusCode } from '../common/constants';
import { createInstruction, type P4Vtab } from '../vdbe/instruction';
import { createDefaultColumnSchema } from '../schema/column';
import { buildColumnIndexMap, findPrimaryKeyDefinition } from '../schema/table';
import type { TableSchema } from '../schema/table';
import type * as AST from '../parser/ast';
import type { Compiler, CursorPlanningResult } from './compiler';
import type { IndexInfo, IndexConstraint, IndexOrderBy, IndexConstraintUsage } from '../vtab/indexInfo';
import type { P4SortKey } from '../vdbe/instruction';

export function allocateMemoryCellsHelper(compiler: Compiler, count: number): number {
	// Frame slots 0 and 1 are reserved for RetAddr and OldFP
	// Locals start at offset 2
	const localsStartOffset = 2;
	const baseOffset = (compiler as any).currentFrameLocals < localsStartOffset ? localsStartOffset : (compiler as any).currentFrameLocals + 1;

	// Update max offset used in this frame
	const newMaxOffset = baseOffset + count - 1;
	(compiler as any).currentFrameLocals = Math.max((compiler as any).currentFrameLocals, newMaxOffset);
	// Track overall max offset used *within this specific frame* for FrameEnter P1
	(compiler as any).maxLocalOffsetInCurrentFrame = Math.max((compiler as any).maxLocalOffsetInCurrentFrame, newMaxOffset);

	// Update overall stack size estimate (absolute index across all frames - potentially inaccurate but a guide)
	// This isn't strictly needed for VDBE execution but helps estimate total stack needed.
	const absoluteIndex = (compiler as any).framePointer + newMaxOffset; // framePointer itself isn't tracked here, this is approximate
	compiler.numMemCells = Math.max(compiler.numMemCells, absoluteIndex);

	return baseOffset; // Return starting offset relative to FP
}

export function allocateCursorHelper(compiler: Compiler): number {
	// Cursors are still global
	const cursorIdx = compiler.numCursors;
	compiler.numCursors++;
	return cursorIdx;
}

export function addConstantHelper(compiler: Compiler, value: SqlValue): number {
	// Constants are global
	const idx = compiler.constants.length;
	compiler.constants.push(value);
	return idx;
}

export function emitInstruction(
	compiler: Compiler,
	opcode: Opcode,
	p1: number = 0,
	p2: number = 0,
	p3: number = 0,
	p4: any = null,
	p5: number = 0,
	comment?: string
): number {
	// Emit to main instructions or subroutine code based on depth
	const targetArray = compiler.subroutineDepth > 0 ? (compiler as any).subroutineCode : compiler.instructions;
	const instruction = createInstruction(opcode, p1, p2, p3, p4, p5, comment);
	targetArray.push(instruction);
	// Return address relative to the start of the *specific code block* (main or subroutine)
	return targetArray.length - 1;
}

export function allocateAddressHelper(compiler: Compiler): number {
	// Placeholder address needs to be relative to the current code block
	const targetArray = compiler.subroutineDepth > 0 ? (compiler as any).subroutineCode : compiler.instructions;
	return -(targetArray.length + 1); // Negative index relative to current block
}

export function resolveAddressHelper(compiler: Compiler, placeholder: number): void {
	if (placeholder >= 0) {
		console.warn(`Attempting to resolve a non-placeholder address: ${placeholder}`);
		return;
	}
	// Resolve based on the current code block (main or subroutine)
	const targetArray = compiler.subroutineDepth > 0 ? (compiler as any).subroutineCode : compiler.instructions;
	const targetAddress = targetArray.length; // Address is the index of the *next* instruction
	const instructionIndex = -(placeholder + 1); // Get original index from placeholder

	if (instructionIndex < 0 || instructionIndex >= targetArray.length) {
		console.warn(`Placeholder address ${placeholder} corresponds to invalid index ${instructionIndex} in current code block.`);
		return;
	}

	const instr = targetArray[instructionIndex];

	// Check which parameter (typically P2) holds the jump target address
	if (instr.p2 === placeholder &&
		(
			instr.opcode === Opcode.Goto ||
			instr.opcode === Opcode.IfTrue ||
			instr.opcode === Opcode.IfFalse ||
			instr.opcode === Opcode.IfZero ||
			instr.opcode === Opcode.IfNull ||
			instr.opcode === Opcode.IfNotNull ||
			instr.opcode === Opcode.Eq ||
			instr.opcode === Opcode.Ne ||
			instr.opcode === Opcode.Lt ||
			instr.opcode === Opcode.Le ||
			instr.opcode === Opcode.Gt ||
			instr.opcode === Opcode.Ge ||
			instr.opcode === Opcode.Once ||
			instr.opcode === Opcode.VFilter ||
			instr.opcode === Opcode.VNext ||
			instr.opcode === Opcode.Rewind ||
			// Subroutine jump target is also P2
			instr.opcode === Opcode.Subroutine
		)
	) {
		instr.p2 = targetAddress;
	} else {
		// Add other opcodes that might use P1 or P3 for addresses if needed
		console.warn(`Instruction at index ${instructionIndex} (${Opcode[instr.opcode]}) does not match placeholder ${placeholder} for P2 update or is not a jump opcode.`);
	}
}

export function getCurrentAddressHelper(compiler: Compiler): number {
	// Address relative to the current code block (main or subroutine)
	const targetArray = compiler.subroutineDepth > 0 ? (compiler as any).subroutineCode : compiler.instructions;
	return targetArray.length;
}

/** Result type for constraint extraction */
export interface ConstraintExtractionResult {
	constraints: IndexConstraint[];
	constraintExpressions: Map<number, AST.Expression>;
	handledNodes: Set<AST.Expression>;
}

// --- Exports for Correlation Analysis ---
/** Type definition for correlated column info */
export interface CorrelatedColumnInfo {
	outerCursor: number;
	outerColumnIndex: number; // Relative to the outer table's schema
	// localRegister is no longer needed here for the push approach
}

/** Result type for subquery correlation analysis */
export interface SubqueryCorrelationResult {
	isCorrelated: boolean;
	correlatedColumns: CorrelatedColumnInfo[];
}
// ---------------------------------------

export function createEphemeralSchemaHelper(
	compiler: Compiler,
	cursorIdx: number,
	numCols: number,
	sortKey?: P4SortKey
): TableSchema {
	const columns = Array.from({ length: numCols }, (_, i) => createDefaultColumnSchema(`eph_col${i}`));
	let pkDef: ReadonlyArray<{ index: number; desc: boolean }> = [];
	if (sortKey) {
		// Set the collation on columns used as keys
		sortKey.keyIndices.forEach((keyIndex, i) => {
			if (keyIndex >= 0 && keyIndex < columns.length && sortKey.collations?.[i]) {
				columns[keyIndex].collation = sortKey.collations[i]!;
			}
		});

		pkDef = Object.freeze(sortKey.keyIndices.map((idx, i) => ({ index: idx, desc: sortKey.directions[i] })));
		pkDef.forEach(def => { if (def.index >= 0 && def.index < columns.length) columns[def.index].primaryKey = true; });
	}

	const tableSchema: TableSchema = {
		name: `ephemeral_${cursorIdx}`,
		schemaName: 'temp',
		columns: Object.freeze(columns),
		columnIndexMap: Object.freeze(buildColumnIndexMap(columns)),
		primaryKeyDefinition: pkDef,
		isVirtual: true,
	};

	compiler.tableSchemas.set(cursorIdx, tableSchema);
	compiler.ephemeralTables.set(cursorIdx, tableSchema);
	return tableSchema;
}

export function closeCursorsUsedBySelectHelper(compiler: Compiler, cursors: number[]): void {
	cursors.forEach(cursorIdx => {
		compiler.emit(Opcode.Close, cursorIdx, 0, 0, null, 0, `Close inner cursor ${cursorIdx}`);
		compiler.tableSchemas.delete(cursorIdx);
		compiler.ephemeralTables.delete(cursorIdx);
		compiler.cursorPlanningInfo.delete(cursorIdx);
	});
}

export function compileFromCoreHelper(compiler: Compiler, sources: AST.FromClause[] | undefined): number[] {
	const openedCursors: number[] = [];
	if (!sources || sources.length === 0) {
		return openedCursors;
	}

	// Helper to recursively open cursors and manage aliases within the current scope
	const openCursorsRecursive = (source: AST.FromClause, currentLevelAliases: Map<string, number>): void => {
		if (source.type === 'table') {
			const tableName = source.table.name;
			const schemaName = source.table.schema || 'main'; // Use schema if provided
			const lookupName = (source.alias || tableName).toLowerCase();
			const cteNameLower = tableName.toLowerCase();

			// --- Check CTE Map FIRST --- //
			const cteInfo = compiler.cteMap.get(cteNameLower);
			if (cteInfo) {
				if (cteInfo.type === 'materialized') {
					const cursor = cteInfo.cursorIdx;
					openedCursors.push(cursor); // Use the existing CTE cursor
					const tableSchema = cteInfo.schema;
					compiler.tableSchemas.set(cursor, tableSchema); // Ensure schema is mapped
					if (compiler.tableAliases.has(lookupName) || currentLevelAliases.has(lookupName)) {
						throw new SqliteError(`Duplicate table name or alias: ${lookupName}`, StatusCode.ERROR, undefined, source.loc?.start.line, source.loc?.start.column);
					}
					compiler.tableAliases.set(lookupName, cursor);
					currentLevelAliases.set(lookupName, cursor);
					// NO OpenRead needed - ephemeral table is already open/managed by CTE logic
					console.log(`FROM: Using materialized CTE '${cteNameLower}' with cursor ${cursor} for alias '${lookupName}'`);
				} else {
					// Add support for other CTE types if needed (e.g., view-like)
					throw new SqliteError(`Unsupported CTE type '${(cteInfo as any).type}' found for ${cteNameLower}`, StatusCode.INTERNAL);
				}
				return; // CTE handled, don't process as regular table
			}
			// -------------------------- //

			// --- If not a CTE, proceed with normal table/vtab lookup --- //
			const cursor = compiler.allocateCursor();
			openedCursors.push(cursor);
			const tableSchema = compiler.db._findTable(tableName, schemaName);
			if (!tableSchema) throw new SqliteError(`Table not found: ${schemaName}.${tableName}`, StatusCode.ERROR, undefined, source.table.loc?.start.line, source.table.loc?.start.column);

			compiler.tableSchemas.set(cursor, tableSchema);
			if (compiler.tableAliases.has(lookupName) || currentLevelAliases.has(lookupName)) {
				throw new SqliteError(`Duplicate table name or alias: ${lookupName}`, StatusCode.ERROR, undefined, source.loc?.start.line, source.loc?.start.column);
			}
			compiler.tableAliases.set(lookupName, cursor);
			currentLevelAliases.set(lookupName, cursor);

			if (tableSchema.isVirtual && tableSchema.vtabInstance) {
				const p4Vtab: P4Vtab = { type: 'vtab', tableSchema };
				compiler.emit(Opcode.OpenRead, cursor, 0, 0, p4Vtab, 0, `Open VTab ${source.alias || tableName}`);
			} else if (tableSchema.isVirtual && !tableSchema.vtabInstance) {
				// Need to connect if instance doesn't exist yet (e.g., schema load)
				console.warn(`VTab ${tableName} found but not connected, attempting connect...`);
				const module = compiler.db._getVtabModule(tableSchema.vtabModuleName ?? '');
				if (!module) throw new SqliteError(`Module ${tableSchema.vtabModuleName} not found for VTab ${tableName}`, StatusCode.ERROR, undefined, source.table.loc?.start.line, source.table.loc?.start.column);
				const argv = [tableSchema.vtabModuleName ?? '', schemaName, tableName, ...(tableSchema.vtabArgs ?? [])];
				// Call connect synchronously
				const instance = module.module.xConnect(compiler.db, module.auxData, argv);
				// Update the stored schema with the instance
				const connectedSchema = { ...tableSchema, vtabInstance: instance };
				compiler.db.schemaManager.getSchema(schemaName)?.addTable(connectedSchema);
				compiler.tableSchemas.set(cursor, connectedSchema);
				const p4Vtab: P4Vtab = { type: 'vtab', tableSchema: connectedSchema };
				compiler.emit(Opcode.OpenRead, cursor, 0, 0, p4Vtab, 0, `Open VTab ${source.alias || tableName}`);
			} else { throw new SqliteError("Regular tables not supported", StatusCode.ERROR, undefined, source.table.loc?.start.line, source.table.loc?.start.column); }
		} else if (source.type === 'join') {
			openCursorsRecursive(source.left, currentLevelAliases);
			openCursorsRecursive(source.right, currentLevelAliases);
		} else if (source.type === 'functionSource') {
			// Handle Table-Valued Function
			const funcName = source.name.name; // Assuming simple identifier for now
			const moduleInfo = compiler.db._getVtabModule(funcName);
			if (!moduleInfo) {
				throw new SqliteError(`Table-valued function or virtual table module not found: ${funcName}`, StatusCode.ERROR, undefined, source.name.loc?.start.line, source.name.loc?.start.column);
			}

			// Compile arguments into temporary registers
			const compiledArgs: string[] = []; // Store evaluated args
			// This part is tricky. Compiling expressions might require registers
			// allocated *before* the async call. Let's assume simple literals/params for now.
			const argRegisters: number[] = [];
			for (const argExpr of source.args) {
				const tempReg = compiler.allocateMemoryCells(1);
				// TODO: Handle potential async nature if compileExpression becomes async
				compiler.compileExpression(argExpr, tempReg);
				// We need the *value* now to pass to xConnect, which requires running VDBE or specific handling
				// This highlights the difficulty of async xConnect during sync compilation.
				// **Compromise for now: Only support literal/parameter args for TVFs**
				if (argExpr.type === 'literal') {
					// Ensure literals passed as args are strings for argv
					if (argExpr.value === null || typeof argExpr.value === 'string') {
						compiledArgs.push(argExpr.value === null ? '' : argExpr.value); // Pass null as empty string?
					} else {
						// Or coerce other literals? For now, error if not string/null.
						throw new SqliteError(`Table-valued function arguments must be string literals (or NULL) for ${funcName}.`, StatusCode.ERROR, undefined, argExpr.loc?.start.line, argExpr.loc?.start.column);
					}
				} else if (argExpr.type === 'parameter') {
					// Parameters aren't available at compile time!
					throw new SqliteError(`Parameters not supported as arguments to table-valued functions like ${funcName} yet.`, StatusCode.ERROR, undefined, argExpr.loc?.start.line, argExpr.loc?.start.column);
				} else {
					throw new SqliteError(`Only literals supported as arguments to table-valued functions like ${funcName} yet.`, StatusCode.ERROR, undefined, argExpr.loc?.start.line, argExpr.loc?.start.column);
				}
				// We don't actually need the registers if we evaluate here
			}

			// Construct argv for xConnect (Ensure all parts are strings)
			const schemaName = 'main'; // Or determine based on context?
			const tableName = source.alias || funcName; // Use alias or function name as table name
			const argv: ReadonlyArray<string> = Object.freeze([funcName, schemaName, tableName, ...compiledArgs]);

			// Call xConnect synchronously
			const instance = moduleInfo.module.xConnect(compiler.db, moduleInfo.auxData, argv);
			if (!instance || !instance.tableSchema) {
				throw new SqliteError(`Module ${funcName} xConnect did not return a valid table instance or schema.`, StatusCode.INTERNAL);
			}

			// Allocate cursor and store schema/instance
			const cursor = compiler.allocateCursor();
			openedCursors.push(cursor);
			compiler.tableSchemas.set(cursor, instance.tableSchema);
			const lookupName = (source.alias || funcName).toLowerCase();
			if (compiler.tableAliases.has(lookupName) || currentLevelAliases.has(lookupName)) {
				throw new SqliteError(`Duplicate table name or alias: ${lookupName}`, StatusCode.ERROR, undefined, source.loc?.start.line, source.loc?.start.column);
			}
			compiler.tableAliases.set(lookupName, cursor);
			currentLevelAliases.set(lookupName, cursor);

			// Emit opcode to open the cursor
			const p4Vtab: P4Vtab = { type: 'vtab', tableSchema: instance.tableSchema };
			compiler.emit(Opcode.OpenRead, cursor, 0, 0, p4Vtab, 0, `Open TVF ${lookupName}`);

		} else {
			throw new SqliteError(`Unsupported FROM clause type during cursor opening: ${(source as any).type}`, StatusCode.INTERNAL);
		}
	};

	// Process each top-level FROM clause (usually just one)
	for (const source of sources) {
		const currentLevelAliases = new Map<string, number>();
		openCursorsRecursive(source, currentLevelAliases);
	}

	return openedCursors;
}

/**
 * Traverses an expression AST to find all referenced columns.
 * Returns a map where keys are cursor indices and values are sets of column indices for that cursor.
 */
function findReferencedColumns(compiler: Compiler, expr: AST.Expression | undefined, activeCursors: ReadonlySet<number>): Map<number, Set<number>> {
	const referenced: Map<number, Set<number>> = new Map();
	if (!expr) return referenced;

	const traverse = (node: AST.Expression) => {
		if (node.type === 'column') {
			const colExpr = node as AST.ColumnExpr;
			let foundCursor = -1;
			if (colExpr.table) {
				foundCursor = compiler.tableAliases.get(colExpr.table.toLowerCase()) ?? -1;
			} else {
				// Unqualified: Check active cursors
				let ambiguous = false;
				for (const cursorId of activeCursors) {
					const schema = compiler.tableSchemas.get(cursorId);
					if (schema?.columnIndexMap.has(colExpr.name.toLowerCase())) {
						if (foundCursor !== -1) ambiguous = true; // Found in multiple active tables
						foundCursor = cursorId;
					}
				}
				if (ambiguous) throw new SqliteError(`Ambiguous column reference in usage analysis: ${colExpr.name}`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
			}

			if (activeCursors.has(foundCursor)) {
				const schema = compiler.tableSchemas.get(foundCursor);
				const colIdx = schema?.columnIndexMap.get(colExpr.name.toLowerCase());
				if (colIdx !== undefined) {
					if (!referenced.has(foundCursor)) {
						referenced.set(foundCursor, new Set());
					}
					referenced.get(foundCursor)!.add(colIdx);
				}
			} else if (foundCursor !== -1) {
				// Column references a table not currently active in this scope (e.g., outer query) - ignore for colUsed mask
			} else {
				// Column not found in active cursors - potentially an error depending on context
				// This might fire incorrectly for outer columns in correlated subqueries during this phase.
				// console.warn(`Column not found during usage analysis: ${colExpr.name}`);
			}
		} else if (node.type === 'binary') {
			traverse(node.left);
			traverse(node.right);
		} else if (node.type === 'unary') {
			traverse(node.expr);
		} else if (node.type === 'function') {
			node.args.forEach(traverse);
		} else if (node.type === 'cast') {
			traverse(node.expr);
		} else if (node.type === 'subquery') {
			// Ideally, recurse into subquery AST, passing appropriate active/outer cursors
			console.warn("Subquery column usage analysis not implemented for colUsed mask.");
		}
		// Literals and parameters don't reference columns
	};

	traverse(expr);
	return referenced;
}

/** Calculate the colUsed bitmask for a specific cursor index */
function calculateColumnUsage(
	compiler: Compiler,
	cursorIdx: number,
	selectColumns: AST.ResultColumn[],
	whereExpr: AST.Expression | undefined,
	orderByExprs: AST.OrderByClause[] | undefined
): bigint {
	let mask = BigInt(0);
	const activeCursors = new Set(compiler.tableAliases.values()); // Consider all tables for now
	const schema = compiler.tableSchemas.get(cursorIdx);
	if (!schema) return mask; // Should not happen

	// Helper to add column index to mask
	const addColToMask = (colIdx: number) => {
		if (colIdx >= 0 && colIdx < 63) { // Check bounds (SQLite limit)
			mask |= (BigInt(1) << BigInt(colIdx));
		} else if (colIdx === -1) {
			// Handle rowid (-1) using bit 63 as per SQLite convention
			mask |= (BigInt(1) << BigInt(63));
		}
	};

	// Check SELECT list
	selectColumns.forEach(rc => {
		if (rc.type === 'all') {
			// Check if the '*' is qualified (e.g., table.*) or unqualified (*)
			let match = false;
			if (!rc.table) {
				match = true; // Unqualified '*' matches all tables
			} else {
				const aliasOrTableName = rc.table.toLowerCase();
				if (compiler.tableAliases.get(aliasOrTableName) === cursorIdx) {
					match = true; // Qualified '*' matches this table's alias/name
				}
			}
			if (match) {
				// Mark all non-hidden columns as used
				schema.columns.forEach((col, idx) => { if (!col.hidden) addColToMask(idx); });
				// Always mark rowid if '*' is used and table is not WITHOUT ROWID
				// Assuming MemoryTable is not WITHOUT ROWID by default
				addColToMask(-1);
			}
		} else if (rc.expr) {
			const refs = findReferencedColumns(compiler, rc.expr, activeCursors);
			refs.get(cursorIdx)?.forEach(addColToMask);
		}
	});

	// Check WHERE clause
	if (whereExpr) {
		const refs = findReferencedColumns(compiler, whereExpr, activeCursors);
		refs.get(cursorIdx)?.forEach(addColToMask);
	}

	// Check ORDER BY clause
	if (orderByExprs) {
		orderByExprs.forEach(ob => {
			const refs = findReferencedColumns(compiler, ob.expr, activeCursors);
			refs.get(cursorIdx)?.forEach(addColToMask);
		});
	}

	// Ensure PK cols are marked if table has PK (implicitly used)
	schema.primaryKeyDefinition.forEach(def => {
		if (def.index >= 0 && def.index < schema.columns.length) {
			addColToMask(def.index);
		}
	});

	return mask;
}

/** Extracts constraints and identifies handled nodes */
function extractConstraints(compiler: Compiler, cursorIdx: number, tableSchema: TableSchema, whereExpr: AST.Expression | undefined, activeOuterCursors: ReadonlySet<number>): ConstraintExtractionResult {
	const constraints: IndexConstraint[] = [];
	const constraintExpressions: Map<number, AST.Expression> = new Map();
	const handledNodes = new Set<AST.Expression>();

	/** Checks if an expression only refers to cursors *outside* the current target cursor (cursorIdx) */
	const isOuterExpr = (expr: AST.Expression): boolean => {
		if (expr.type === 'literal' || expr.type === 'parameter') return true;
		if (expr.type === 'column') {
			const colExpr = expr as AST.ColumnExpr;
			let sourceCursor = -1;
			if (colExpr.table) {
				// Check against all known aliases
				sourceCursor = compiler.tableAliases.get(colExpr.table.toLowerCase()) ?? -1;
			} else {
				// Unqualified: Search all active cursors *except* the target cursor
				let foundInTarget = false;
				let foundInOuter = false;
				let ambiguous = false;

				// Check target cursor first
				if (tableSchema.columnIndexMap.has(colExpr.name.toLowerCase())) {
					foundInTarget = true;
					sourceCursor = cursorIdx;
				}

				// Check other active cursors (outer + siblings)
				for (const otherCursorId of compiler.tableAliases.values()) {
					if (otherCursorId === cursorIdx) continue; // Skip self
					const otherSchema = compiler.tableSchemas.get(otherCursorId);
					if (otherSchema?.columnIndexMap.has(colExpr.name.toLowerCase())) {
						if (foundInTarget || foundInOuter) ambiguous = true;
						sourceCursor = otherCursorId;
						foundInOuter = true;
					}
				}
				if (ambiguous) throw new SqliteError(`Ambiguous column in constraint analysis: ${colExpr.name}`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
			}
			// It's an outer expression if the resolved cursor is NOT the target cursor
			return sourceCursor !== -1 && sourceCursor !== cursorIdx;
		}
		// Recursively check components of complex expressions
		if (expr.type === 'binary') {
			// For a binary expr to be "outer", BOTH sides must be outer (or literal/param)
			return isOuterExpr(expr.left) && isOuterExpr(expr.right);
		}
		if (expr.type === 'unary') {
			return isOuterExpr(expr.expr);
		}
		if (expr.type === 'function') {
			// Function result depends on its arguments
			return expr.args.every(isOuterExpr);
		}
		if (expr.type === 'subquery') {
			// Subqueries are complex, assume not outer for simplicity
			return false;
		}
		if (expr.type === 'cast') {
			return isOuterExpr(expr.expr);
		}
		return false; // Default case
	}

	const traverse = (expr: AST.Expression | undefined) => {
		if (!expr) return;

		// Check if this node itself is handled by a recursive call (e.g., left/right of AND)
		if (handledNodes.has(expr)) return;

		// Handle IS NULL / IS NOT NULL
		if (expr.type === 'unary' && (expr.operator.toUpperCase() === 'IS NULL' || expr.operator.toUpperCase() === 'IS NOT NULL')) {
			if (expr.expr.type === 'column') {
				const colExpr = expr.expr;
				const colNameLower = colExpr.name.toLowerCase();
				let sourceCursor = -1;
				if (colExpr.table) {
					sourceCursor = compiler.tableAliases.get(colExpr.table.toLowerCase()) ?? -1;
				} else {
					// Resolve unqualified column name
					if (tableSchema.columnIndexMap.has(colNameLower)) {
						sourceCursor = cursorIdx;
					} // Check other cursors if needed, but assume error if ambiguous here
				}

				if (sourceCursor === cursorIdx) { // Check if it belongs to the target table
					const colIdx = tableSchema.columnIndexMap.get(colNameLower);
					if (colIdx !== undefined) {
						const op = expr.operator.toUpperCase() === 'IS NULL' ? IndexConstraintOp.ISNULL : IndexConstraintOp.ISNOTNULL;
						const constraintIdx = constraints.length;
						constraints.push({ iColumn: colIdx, op: op, usable: true });
						constraintExpressions.set(constraintIdx, expr); // Store the unary expression itself
						handledNodes.add(expr); // Mark this unary node as handled
					}
				}
			}
			return; // Don't traverse further down this branch
		}

		if (expr.type === 'binary') {
			const binExpr = expr as AST.BinaryExpr;
			if (binExpr.operator.toUpperCase() === 'AND') {
				// Recursively check left and right, handledNodes will be updated
				traverse(binExpr.left);
				traverse(binExpr.right);
				// If both children were handled, potentially mark the AND node itself?
				// For now, only mark the terminal constraints.
				return;
			}
			if (binExpr.operator.toUpperCase() === 'OR') {
				console.debug("Skipping OR constraint for xBestIndex planning.");
				return; // OR clauses are not pushed down
			}

			// Handle BETWEEN x AND y -> >= x AND <= y
			if (binExpr.operator.toUpperCase() === 'BETWEEN') {
				if (binExpr.left.type === 'column' && binExpr.right.type === 'binary' && binExpr.right.operator.toUpperCase() === 'AND') {
					const colExpr = binExpr.left;
					const lowerBoundExpr = binExpr.right.left;
					const upperBoundExpr = binExpr.right.right;

					// Create synthetic AST nodes for the constraints
					const geExpr: AST.BinaryExpr = { type: 'binary', operator: '>=', left: colExpr, right: lowerBoundExpr, loc: binExpr.loc }; // Pass loc
					const leExpr: AST.BinaryExpr = { type: 'binary', operator: '<=', left: colExpr, right: upperBoundExpr, loc: binExpr.loc }; // Pass loc

					traverse(geExpr); // Check if >= can be handled
					traverse(leExpr); // Check if <= can be handled

					// If BOTH components were handled, mark the original BETWEEN node
					// Note: This check might be overly strict if traverse logic changes.
					// Let's rely on traverse marking the synthetic ge/le nodes individually.
					// if (handledNodes.has(geExpr) && handledNodes.has(leExpr)) {
					// 	handledNodes.add(binExpr);
					// }
				} else {
					console.warn("Unsupported BETWEEN structure for planning.");
				}
				return;
			}

			// Handle IN (list) -> multiple EQ constraints
			if (binExpr.operator.toUpperCase() === 'IN') {
				if (binExpr.left.type === 'column' && binExpr.right.type === 'function' && binExpr.right.name === '_list_') {
					const colExpr = binExpr.left;
					const listValues = binExpr.right.args;

					// Resolve column source
					let sourceCursor = -1;
					const colNameLower = colExpr.name.toLowerCase();
					if (colExpr.table) {
						sourceCursor = compiler.tableAliases.get(colExpr.table.toLowerCase()) ?? -1;
					} else {
						if (tableSchema.columnIndexMap.has(colNameLower)) {
							sourceCursor = cursorIdx;
						}
					}

					// Check if column belongs to target table and all list values are outer/constant
					if (sourceCursor === cursorIdx && listValues.every(isOuterExpr)) {
						const colIdx = tableSchema.columnIndexMap.get(colNameLower);
						if (colIdx !== undefined) {
							listValues.forEach(valueExpr => {
								const constraintIdx = constraints.length;
								constraints.push({ iColumn: colIdx, op: IndexConstraintOp.EQ, usable: true });
								constraintExpressions.set(constraintIdx, valueExpr);
							});
							handledNodes.add(binExpr); // Mark the entire IN expression node
						}
					}
				} else if (binExpr.right.type === 'subquery') {
					console.warn("IN (subquery) constraint skipped for xBestIndex planning.");
				}
				return; // Handled (or skipped)
			}

			// Standard binary comparison: col op value or value op col
			let colExpr: AST.ColumnExpr | undefined;
			let valueExpr: AST.Expression | undefined;
			let op: IndexConstraintOp | undefined;
			let swapped = false;
			let colCursor = -1;

			if (binExpr.left.type === 'column') {
				colExpr = binExpr.left;
				valueExpr = binExpr.right;
				op = mapAstOperatorToConstraintOp(binExpr.operator);
				// Resolve cursor for left column
				if (colExpr.table) colCursor = compiler.tableAliases.get(colExpr.table.toLowerCase()) ?? -1;
				else if (tableSchema.columnIndexMap.has(colExpr.name.toLowerCase())) colCursor = cursorIdx;
			} else if (binExpr.right.type === 'column') {
				colExpr = binExpr.right;
				valueExpr = binExpr.left;
				swapped = true;
				op = mapAstOperatorToConstraintOp(binExpr.operator, true);
				// Resolve cursor for right column
				if (colExpr.table) colCursor = compiler.tableAliases.get(colExpr.table.toLowerCase()) ?? -1;
				else if (tableSchema.columnIndexMap.has(colExpr.name.toLowerCase())) colCursor = cursorIdx;
			}

			// Check if it's a usable constraint (column belongs to target table, value is outer/constant)
			if (colExpr && op && valueExpr && colCursor === cursorIdx) {
				if (isOuterExpr(valueExpr)) {
					const colIdx = tableSchema.columnIndexMap.get(colExpr.name.toLowerCase());
					if (colIdx !== undefined) {
						const constraintIdx = constraints.length;
						constraints.push({ iColumn: colIdx, op: op, usable: true });
						constraintExpressions.set(constraintIdx, valueExpr);
						handledNodes.add(binExpr); // Mark this binary node as handled
					}
				} else {
					console.debug(`Skipping constraint for xBestIndex (value references target table): ${colExpr.name} ${binExpr.operator} ...`);
				}
			}
			// Potential JOIN condition: col1 op col2 (where one is target, one is outer)
			else if (binExpr.left.type === 'column' && binExpr.right.type === 'column') {
				const col1 = binExpr.left;
				const col2 = binExpr.right;
				const col1Cursor = compiler.tableAliases.get(col1.table?.toLowerCase() ?? '') ?? (tableSchema.columnIndexMap.has(col1.name.toLowerCase()) ? cursorIdx : -1);
				const col2Cursor = compiler.tableAliases.get(col2.table?.toLowerCase() ?? '') ?? (tableSchema.columnIndexMap.has(col2.name.toLowerCase()) ? cursorIdx : -1);

				let targetCol: AST.ColumnExpr | undefined;
				let outerCol: AST.ColumnExpr | undefined;
				let effectiveOp: IndexConstraintOp | undefined;

				if (col1Cursor === cursorIdx && col2Cursor !== -1 && col2Cursor !== cursorIdx) {
					targetCol = col1;
					outerCol = col2;
					effectiveOp = mapAstOperatorToConstraintOp(binExpr.operator, false);
				} else if (col2Cursor === cursorIdx && col1Cursor !== -1 && col1Cursor !== cursorIdx) {
					targetCol = col2;
					outerCol = col1;
					effectiveOp = mapAstOperatorToConstraintOp(binExpr.operator, true); // Swapped args
				}

				if (targetCol && outerCol && effectiveOp) {
					const colIdx = tableSchema.columnIndexMap.get(targetCol.name.toLowerCase());
					if (colIdx !== undefined) {
						const constraintIdx = constraints.length;
						constraints.push({ iColumn: colIdx, op: effectiveOp, usable: true });
						constraintExpressions.set(constraintIdx, outerCol); // Value is the outer column
						handledNodes.add(binExpr); // Mark join node as handled
					}
				}
			}
		}
	};

	traverse(whereExpr);

	return { constraints, constraintExpressions, handledNodes };
}

export function planTableAccessHelper(
	compiler: Compiler,
	cursorIdx: number,
	tableSchema: TableSchema,
	stmt: AST.SelectStmt | AST.UpdateStmt | AST.DeleteStmt,
	activeOuterCursors: ReadonlySet<number>
): void {
	if (!tableSchema.isVirtual || !tableSchema.vtabModule?.xBestIndex || !tableSchema.vtabInstance) {
		compiler.cursorPlanningInfo.set(cursorIdx, {
			idxNum: 0,
			idxStr: null,
			usage: [],
			cost: 1e10,
			rows: BigInt(1000000),
			orderByConsumed: false,
			constraints: [],
			constraintExpressions: new Map(),
			handledWhereNodes: new Set(), // Initialize handled nodes as empty set
		});
		return;
	}

	// Determine relevant clauses based on statement type
	const whereExpr = stmt.type === 'select' || stmt.type === 'update' || stmt.type === 'delete' ? stmt.where : undefined;
	const orderByExprs = stmt.type === 'select' ? stmt.orderBy : undefined;
	const selectColumns = stmt.type === 'select' ? stmt.columns : []; // Need select cols for colUsed

	// Extract constraints and identify handled nodes
	const { constraints, constraintExpressions, handledNodes } = extractConstraints(
		compiler, cursorIdx, tableSchema, whereExpr, activeOuterCursors
	);

	// Prepare ORDER BY info
	const orderBy: IndexOrderBy[] = [];
	if (orderByExprs) {
		orderByExprs.forEach(ob => {
			if (ob.expr.type === 'column') {
				const colExpr = ob.expr as AST.ColumnExpr;
				const colNameLower = colExpr.name.toLowerCase();
				let sourceCursor = -1;
				// Resolve column source carefully
				if (colExpr.table) {
					sourceCursor = compiler.tableAliases.get(colExpr.table.toLowerCase()) ?? -1;
				} else {
					// Check target cursor first
					if (tableSchema.columnIndexMap.has(colNameLower)) {
						sourceCursor = cursorIdx;
						// Check for ambiguity with outer cursors
						for (const outerC of activeOuterCursors) {
							if (compiler.tableSchemas.get(outerC)?.columnIndexMap.has(colNameLower)) {
								sourceCursor = -1; // Ambiguous
								break;
							}
						}
					} else {
						// Check outer cursors only if not found in target
						for (const outerC of activeOuterCursors) {
							if (compiler.tableSchemas.get(outerC)?.columnIndexMap.has(colNameLower)) {
								sourceCursor = outerC; // Belongs to outer
								break;
							}
						}
					}
				}

				// Add to orderBy array only if it belongs *solely* to the target table
				if (sourceCursor === cursorIdx) {
					const colIdx = tableSchema.columnIndexMap.get(colNameLower);
					if (colIdx !== undefined) {
						orderBy.push({ iColumn: colIdx, desc: ob.direction === 'desc' });
					} else if (colNameLower === 'rowid') {
						orderBy.push({ iColumn: -1, desc: ob.direction === 'desc' });
					}
				}
			} else {
				console.warn("Skipping non-column ORDER BY term for xBestIndex planning");
			}
		});
	}

	// Calculate column usage mask
	const colUsed = calculateColumnUsage(compiler, cursorIdx, selectColumns, whereExpr, orderByExprs);

	// Prepare IndexInfo structure for xBestIndex call
	const indexInfo: IndexInfo = {
		nConstraint: constraints.length,
		aConstraint: Object.freeze([...constraints]), // Pass constraints relevant to this vtab
		nOrderBy: orderBy.length,
		aOrderBy: Object.freeze([...orderBy]), // Pass order by relevant to this vtab
		colUsed: colUsed,
		aConstraintUsage: Array.from({ length: constraints.length }, () => ({ argvIndex: 0, omit: false })), // Output array
		// --- Outputs (initialized to defaults) ---
		idxNum: 0,
		idxStr: null,
		orderByConsumed: false,
		estimatedCost: 1e10, // High initial cost
		estimatedRows: BigInt(1000000), // Large initial row estimate
		idxFlags: 0,
	};

	// Call xBestIndex
	let status: number;
	try {
		status = tableSchema.vtabModule.xBestIndex(tableSchema.vtabInstance, indexInfo);
	} catch (e) {
		console.error(`Error calling xBestIndex for ${tableSchema.name}:`, e);
		status = StatusCode.ERROR;
	}

	if (status !== StatusCode.OK) {
		throw new SqliteError(`xBestIndex failed for table ${tableSchema.name} with code ${status}`, status, undefined, stmt.loc?.start.line, stmt.loc?.start.column);
	}

	// Store the results from xBestIndex
	const planResult: CursorPlanningResult = {
		idxNum: indexInfo.idxNum,
		idxStr: indexInfo.idxStr,
		usage: indexInfo.aConstraintUsage, // Get the usage array filled by xBestIndex
		cost: indexInfo.estimatedCost,
		rows: indexInfo.estimatedRows,
		orderByConsumed: indexInfo.orderByConsumed,
		constraints: [...indexInfo.aConstraint], // Store constraints passed to xBestIndex
		constraintExpressions: constraintExpressions, // Store map from constraint index to its value expression
		handledWhereNodes: handledNodes, // Store the set of WHERE clause nodes handled by this plan
	};
	compiler.cursorPlanningInfo.set(cursorIdx, planResult);

	console.log(`Planning for ${tableSchema.name} (cursor ${cursorIdx}, outer: ${[...activeOuterCursors]}): idxNum=${planResult.idxNum}, cost=${planResult.cost}, rows=${planResult.rows}, usage=`, planResult.usage, `handledNodes=${planResult.handledWhereNodes.size}`, `colUsed=${colUsed.toString(2)}`);
}

function mapAstOperatorToConstraintOp(op: string, swapped: boolean = false): IndexConstraintOp | undefined {
	const upperOp = op.toUpperCase();
	switch (upperOp) {
		case '=': case '==': return IndexConstraintOp.EQ;
		case '<': return swapped ? IndexConstraintOp.GT : IndexConstraintOp.LT;
		case '<=': return swapped ? IndexConstraintOp.GE : IndexConstraintOp.LE;
		case '>': return swapped ? IndexConstraintOp.LT : IndexConstraintOp.GT;
		case '>=': return swapped ? IndexConstraintOp.LE : IndexConstraintOp.GE;
		case '!=': case '<>': return IndexConstraintOp.NE;
		case 'IS': return IndexConstraintOp.IS; // Needs careful handling if value is not NULL
		case 'IS NOT': return IndexConstraintOp.ISNOT; // Needs careful handling
		case 'LIKE': return IndexConstraintOp.LIKE;
		case 'GLOB': return IndexConstraintOp.GLOB;
		case 'REGEXP': return IndexConstraintOp.REGEXP;
		case 'MATCH': return IndexConstraintOp.MATCH;
		// IS NULL / IS NOT NULL are handled directly as unary operators in extractConstraints
		// BETWEEN and IN handled by decomposition in extractConstraints
		default: return undefined;
	}
}

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
	// Only verify if there was a plan and it used some constraints
	if (!planningInfo || planningInfo.constraints.length === 0 || planningInfo.usage.every(u => u.argvIndex === 0)) {
		return;
	}

	const tempReg = compiler.allocateMemoryCells(1);
	const tableSchema = compiler.tableSchemas.get(cursorIdx);
	if (!tableSchema) throw new Error(`Internal: Schema missing for cursor ${cursorIdx} during verification`);

	for (let i = 0; i < planningInfo.constraints.length; i++) {
		const constraint = planningInfo.constraints[i];
		const usage = planningInfo.usage[i];

		// Only verify constraints used by the plan (argvIndex > 0) AND not marked as 'omit'
		if (usage.argvIndex > 0 && !usage.omit) {
			const originalValueExpr = planningInfo.constraintExpressions.get(i);

			// Reconstruct the expression for verification.
			// This involves the column from the current cursor and the original value expression.
			let verificationExpr: AST.Expression | null = null;
			let verificationExprLoc: AST.AstNode['loc'] | undefined = originalValueExpr?.loc; // Default to value expr loc

			if (constraint.iColumn === -1) {
				// TODO: Handle rowid verification if needed (e.g., using a special function/opcode?)
				console.warn(`Verification of rowid constraint (constraint ${i}) not implemented.`);
				continue;
			}

			const colName = tableSchema.columns[constraint.iColumn]?.name;
			if (!colName) {
				console.error(`Cannot find column name for index ${constraint.iColumn} in table ${tableSchema.name} during verification.`);
				continue;
			}
			// Synthesize a ColumnExpr - no real location, but needed for structure
			const colExpr: AST.ColumnExpr = { type: 'column', name: colName };

			// Handle IS NULL / IS NOT NULL (originalValueExpr is the unary expr itself)
			if (constraint.op === IndexConstraintOp.ISNULL || constraint.op === IndexConstraintOp.ISNOTNULL) {
				if (originalValueExpr?.type === 'unary') {
					// Reconstruct unary with our synthesized colExpr
					verificationExpr = { ...originalValueExpr, expr: colExpr };
					verificationExprLoc = originalValueExpr.loc;
				} else {
					console.warn(`Cannot reconstruct IS NULL/IS NOT NULL verification expression for constraint ${i}.`);
					continue;
				}
			}
			// Handle standard binary operators
			else {
				if (!originalValueExpr) {
					// This might happen for MATCH where the right side isn't stored,
					// or if constraint extraction failed (e.g. IN (list) where list isn't stored here)
					console.warn(`Could not find original value expression for constraint verification (cursor ${cursorIdx}, constraint ${i}, op ${constraint.op})`);
					continue;
				}
				// Map the constraint op back to an AST operator string
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

				// Construct the binary expression: colExpr op originalValueExpr
				// Use the location of the original value expression for the combined expression
				const binaryExpr: AST.BinaryExpr = { type: 'binary', operator: opInfo.op, left: colExpr, right: originalValueExpr, loc: verificationExprLoc };
				verificationExpr = binaryExpr;
			}

			// Compile and check the verification expression
			if (verificationExpr) {
				// Pass the original location when compiling
				compiler.compileExpression(verificationExpr, tempReg);
				// Use the original operator string if available, otherwise the op code number
				const opStr = (verificationExpr.type === 'unary' ? verificationExpr.operator : (verificationExpr.type === 'binary' ? verificationExpr.operator : `op${constraint.op}`));
				compiler.emit(Opcode.IfFalse, tempReg, jumpTargetIfFalse, 0, null, 0, `Verify constraint ${i} (${opStr})`);
			}
		}
	}
}

/**
 * Compiles only the parts of a WHERE expression that were NOT handled by
 * the query plan (xBestIndex or verifyWhereConstraints).
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

	// Gather all handled nodes from the plans of active cursors
	const allHandledNodes = new Set<AST.Expression>();
	activeCursors.forEach(cursorIdx => {
		compiler.cursorPlanningInfo.get(cursorIdx)?.handledWhereNodes.forEach(node => {
			allHandledNodes.add(node);
		});
	});

	// Recursive function to compile unhandled parts
	const compileRecursive = (node: AST.Expression) => {
		// If the node itself was handled by a plan, skip it and its children
		if (allHandledNodes.has(node)) {
			return;
		}

		if (node.type === 'binary') {
			if (node.operator.toUpperCase() === 'AND') {
				// For AND, recursively compile left then right.
				// If left fails, the IfFalse jump will skip the right.
				compileRecursive(node.left);
				compileRecursive(node.right);
			} else if (node.operator.toUpperCase() === 'OR') {
				// OR is trickier as it wasn't handled by the planner.
				// We need to compile it fully if the OR node itself wasn't handled.
				const orReg = compiler.allocateMemoryCells(1);
				const addrOrTrue = compiler.allocateAddress(); // Jump here if left or right is true

				// Compile left side
				compiler.compileExpression(node.left, orReg);
				compiler.emit(Opcode.IfTrue, orReg, addrOrTrue, 0, null, 0, "OR: check left");

				// Compile right side only if left is false
				compiler.compileExpression(node.right, orReg);
				// If right is also false, jump to the overall failure target
				compiler.emit(Opcode.IfFalse, orReg, jumpTargetIfFalse, 0, null, 0, "OR: check right, jump if false");

				// If either was true, jump here
				compiler.resolveAddress(addrOrTrue);
				// Fall through if OR condition is met
			} else {
				// Other binary operators (like LIKE, >, etc.) that weren't planned
				const tempReg = compiler.allocateMemoryCells(1);
				compiler.compileExpression(node, tempReg);
				compiler.emit(Opcode.IfFalse, tempReg, jumpTargetIfFalse, 0, null, 0, `Check unhandled: ${node.operator}`);
			}
		} else if (node.type === 'unary') {
			// Handle unary operators (like NOT, IS NULL) that weren't handled
			const tempReg = compiler.allocateMemoryCells(1);
			compiler.compileExpression(node, tempReg);
			compiler.emit(Opcode.IfFalse, tempReg, jumpTargetIfFalse, 0, null, 0, `Check unhandled: ${node.operator}`);
		} else {
			// Compile any other unhandled node type directly
			const tempReg = compiler.allocateMemoryCells(1);
			compiler.compileExpression(node, tempReg);
			compiler.emit(Opcode.IfFalse, tempReg, jumpTargetIfFalse, 0, null, 0, `Check unhandled: ${node.type}`);
		}
	};

	compileRecursive(expr);
}

/**
 * Analyzes a subquery AST to detect correlation with outer query cursors.
 */
export function analyzeSubqueryCorrelation(
	compiler: Compiler,
	subqueryAst: AST.AstNode,
	activeOuterCursors: ReadonlySet<number> // Cursors available in the *outer* scope
): SubqueryCorrelationResult {
	const result: SubqueryCorrelationResult = {
		isCorrelated: false,
		correlatedColumns: [],
	};
	const processedColumns = new Set<string>(); // Track "cursor.colIdx"

	// Recursive traversal function
	const traverse = (node: AST.AstNode | undefined | null, availableCursors: ReadonlySet<number>) => {
		if (!node) return;

		// Handle SELECT statements (introduces new scope)
		if (node.type === 'select') {
			const sel = node as AST.SelectStmt;
			const currentLevelAliases = new Map<string, number>();
			const currentLevelCursors = new Set<number>();

			// Identify cursors defined *at this level*
			sel.from?.forEach(fromClause => {
				const findCursors = (fc: AST.FromClause) => {
					if (fc.type === 'table') {
						const alias = (fc.alias || fc.table.name).toLowerCase();
						const cursorId = compiler.tableAliases.get(alias); // Check global alias map
						if (cursorId !== undefined) {
							currentLevelAliases.set(alias, cursorId);
							currentLevelCursors.add(cursorId);
						} else {
							console.warn(`Alias/Table ${alias} not found in global map during correlation analysis.`);
						}
					} else if (fc.type === 'join') {
						findCursors(fc.left);
						findCursors(fc.right);
					}
				};
				findCursors(fromClause);
			});

			const nextAvailableCursors = new Set([...availableCursors, ...currentLevelCursors]);

			// Recurse into sub-components
			sel.columns.forEach(c => { if (c.type === 'column' && c.expr) traverse(c.expr, nextAvailableCursors); });
			traverse(sel.where, nextAvailableCursors);
			sel.groupBy?.forEach(g => traverse(g, nextAvailableCursors));
			traverse(sel.having, nextAvailableCursors);

			return;
		}

		// Handle Column References
		if (node.type === 'column') {
			const colExpr = node as AST.ColumnExpr;
			let sourceCursor = -1;

			if (colExpr.table) {
				sourceCursor = compiler.tableAliases.get(colExpr.table.toLowerCase()) ?? -1;
			} else {
				let foundCursorId = -1;
				let ambiguous = false;
				for (const cursorId of availableCursors) {
					const schema = compiler.tableSchemas.get(cursorId);
					if (schema?.columnIndexMap.has(colExpr.name.toLowerCase())) {
						if (foundCursorId !== -1) ambiguous = true;
						foundCursorId = cursorId;
					}
				}
				if (ambiguous) throw new SqliteError(`Ambiguous column in subquery correlation check: ${colExpr.name}`, StatusCode.ERROR, undefined, node.loc?.start.line, node.loc?.start.column);
				sourceCursor = foundCursorId;
			}

			if (sourceCursor !== -1 && activeOuterCursors.has(sourceCursor)) {
				const outerCursor = sourceCursor;
				const outerSchema = compiler.tableSchemas.get(outerCursor);
				const outerColIdx = outerSchema?.columnIndexMap.get(colExpr.name.toLowerCase()) ?? -1;
				if (outerColIdx !== -1) {
					result.isCorrelated = true;
					const key = `${outerCursor}.${outerColIdx}`;
					if (!processedColumns.has(key)) {
						result.correlatedColumns.push({ outerCursor: outerCursor, outerColumnIndex: outerColIdx });
						processedColumns.add(key);
					}
				} else {
					console.warn(`Outer column ${colExpr.name} resolved to cursor ${outerCursor} but index not found in schema.`);
				}
			}
		}
		// --- Recurse into other expression types ---
		else if (node.type === 'binary') { traverse((node as AST.BinaryExpr).left, availableCursors); traverse((node as AST.BinaryExpr).right, availableCursors); }
		else if (node.type === 'unary') { traverse((node as AST.UnaryExpr).expr, availableCursors); }
		else if (node.type === 'function') { (node as AST.FunctionExpr).args.forEach(arg => traverse(arg, availableCursors)); }
		else if (node.type === 'cast') { traverse((node as AST.CastExpr).expr, availableCursors); }
		else if (node.type === 'subquery') { traverse((node as AST.SubqueryExpr).query, availableCursors); }
	};

	traverse(subqueryAst, activeOuterCursors);
	return result;
}

