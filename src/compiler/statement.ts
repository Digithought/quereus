import { Opcode, ConflictResolution } from '../common/constants';
import { StatusCode } from '../common/types';
import { SqliteError } from '../common/errors';
import { type P4Update, type P4Vtab } from '../vdbe/instruction';
import type { Compiler } from './compiler';
import type * as AST from '../parser/ast';
import { compileUnhandledWhereConditions } from './whereVerify';
import { compileExpression, type ArgumentMap } from './expression';
import { compileLiteralValue } from './utils';

export function compileInsertStatement(compiler: Compiler, stmt: AST.InsertStmt): void {
	const tableSchema = compiler.db._findTable(stmt.table.name, stmt.table.schema);
	if (!tableSchema) { throw new SqliteError(`Table not found: ${stmt.table.schema || 'main'}.${stmt.table.name}`, StatusCode.ERROR, undefined, stmt.table.loc?.start.line, stmt.table.loc?.start.column); }
	if (!tableSchema.isVirtual || !tableSchema.vtabInstance || !tableSchema.vtabModule?.xUpdate) { throw new SqliteError(`Table ${tableSchema.name} is not a virtual table supporting INSERT`, StatusCode.ERROR, undefined, stmt.table.loc?.start.line, stmt.table.loc?.start.column); }

	let targetColumns = stmt.columns;
	if (!targetColumns) {
		targetColumns = tableSchema.columns.filter(c => !c.hidden).map(c => c.name);
	} else {
		const schemaCols = new Set(tableSchema.columns.map(c => c.name.toLowerCase()));
		for (const col of targetColumns) {
			if (!schemaCols.has(col.toLowerCase())) {
				throw new SqliteError(`Column '${col}' not found in table '${tableSchema.name}'`, StatusCode.ERROR, undefined, stmt.loc?.start.line, stmt.loc?.start.column);
			}
		}
	}
	const numCols = targetColumns.length;
	const targetColumnIndices = targetColumns.map(name => tableSchema.columnIndexMap.get(name.toLowerCase())!);

	const cursor = compiler.allocateCursor();
	const p4Vtab: P4Vtab = { type: 'vtab', tableSchema };
	compiler.emit(Opcode.OpenWrite, cursor, numCols, 0, p4Vtab, 0, `OpenWrite ${tableSchema.name}`);

	const regNewRowid = compiler.allocateMemoryCells(1);
	const regDataStart = compiler.allocateMemoryCells(tableSchema.columns.length + 1);

	if (stmt.values) {
		for (const valueRow of stmt.values) {
			if (valueRow.length !== numCols) { throw new SqliteError(`Column count mismatch: table ${tableSchema.name} expected ${numCols} columns, but ${valueRow.length} values were supplied`, StatusCode.ERROR, undefined, stmt.loc?.start.line, stmt.loc?.start.column); }

			compiler.emit(Opcode.Null, 0, regDataStart, 0, null, 0, "Rowid=NULL for INSERT");
			for (let i = 0; i < tableSchema.columns.length; i++) {
				compiler.emit(Opcode.Null, 0, regDataStart + 1 + i);
			}
			const valueRegisters = new Map<number, number>();
			for (let i = 0; i < numCols; i++) {
				const schemaColIndex = targetColumnIndices[i];
				const valueReg = compiler.allocateMemoryCells(1);
				compiler.compileExpression(valueRow[i], valueReg);

				// Check NOT NULL constraint if applicable
				const columnSchema = tableSchema.columns[schemaColIndex];
				if (columnSchema.notNull) {
					// Use allocateMemoryCells, no explicit freeing
					const regIsNullResult = compiler.allocateMemoryCells(1);
					const addrConstraintFail = compiler.allocateAddress();
					const addrConstraintOK = compiler.allocateAddress();
					const constraintContext = `${tableSchema.name}.${columnSchema.name}`;

					// Is value in valueReg NULL? Store result in regIsNullResult
					compiler.emit(Opcode.IsNull, valueReg, regIsNullResult, 0, null, 0, `Check NULL ${constraintContext}`);
					// If regIsNullResult is TRUE (value was NULL), jump to failure handler
					compiler.emit(Opcode.IfTrue, regIsNullResult, addrConstraintFail, 0, null, 0, `Jump if NULL ${constraintContext}`);

					// If we got here, value was NOT NULL. Jump over the failure handler.
					compiler.emit(Opcode.Goto, 0, addrConstraintOK, 0, null, 0, 'Skip violation');

					// --- Failure Handler ---
					compiler.resolveAddress(addrConstraintFail);
					compiler.emit(Opcode.ConstraintViolation, 0, 0, 0, `NOT NULL constraint failed: ${constraintContext}`, 0, `THROW ${constraintContext}`);
					// --- End Failure Handler ---

					compiler.resolveAddress(addrConstraintOK); // Continue execution here
					// No freeTempRegister call needed
				}
				valueRegisters.set(schemaColIndex, valueReg);
			}

			// --- Compile CHECK constraints ---
			if (tableSchema.checkConstraints && tableSchema.checkConstraints.length > 0) {
				// Create the argument map for CHECK constraints: string(colIndex) -> register
				// Use mutable Map locally, but pass as ArgumentMap (ReadonlyMap)
				const checkArgMap: Map<string, number> = new Map<string, number>();
				valueRegisters.forEach((reg, index) => {
					checkArgMap.set(`${index}`, reg); // Key is stringified index
				});
				// Also add rowid if needed? Assume VColumn handles rowid for now.

				tableSchema.checkConstraints.forEach((constraint, idx) => {
					const checkExpr = constraint.expr;
					const constraintName = constraint.name ?? `check_${idx}`;
					const constraintContext = `CHECK constraint ${constraintName} on ${tableSchema.name}`;

					// Allocate register for check result
					const regCheckResult = compiler.allocateMemoryCells(1);
					const addrCheckFail = compiler.allocateAddress();
					const addrCheckOK = compiler.allocateAddress();

					// Compile the CHECK expression, passing the map of new values.
					// compileColumn handler should now prioritize this map.
					compiler.compileExpression(checkExpr, regCheckResult, undefined, undefined, checkArgMap);

					// If result is TRUE (non-zero, non-null), jump past the failure.
					// Otherwise, fall through to the ConstraintViolation.
					compiler.emit(Opcode.IfTrue, regCheckResult, addrCheckOK, 0, null, 0, `If true, skip violation ${constraintName}`);

					// --- Failure Handler --- (Executed if IfTrue doesn't jump)
					// Use stringifyExpr(checkExpr) if available, otherwise just use name
					const errorMsg = `CHECK constraint failed: ${constraintName}`;
					compiler.emit(Opcode.ConstraintViolation, 0, 0, 0, errorMsg, 0, `THROW ${constraintName}`);
					// Jump to end if violation occurred (e.g., if there's cleanup code later, though likely program halts)
					// compiler.emit(Opcode.Goto, 0, endOfChecksAddr, 0, null, 0);
					// --- End Failure Handler ---

					compiler.resolveAddress(addrCheckOK); // Continue execution here if check passed
				});
			}
			// --- End CHECK constraints ---

			// Populate the data registers for VUpdate, handling DEFAULT values
			for (let i = 0; i < tableSchema.columns.length; i++) {
				const destReg = regDataStart + 1 + i;
				const providedValueReg = valueRegisters.get(i);
				const columnSchema = tableSchema.columns[i];

				if (providedValueReg !== undefined) {
					// Value was provided in INSERT statement
					compiler.emit(Opcode.SCopy, providedValueReg, destReg, 0, null, 0, `Copy provided value for col ${i} (${columnSchema.name})`);
					// NOT NULL check already performed when value was compiled
				} else {
					// Value not provided, check for DEFAULT
					if (columnSchema.defaultValue !== undefined) {
						// Compile or load the DEFAULT value
						const regDefaultValue = compiler.allocateMemoryCells(1);
						if (typeof columnSchema.defaultValue === 'object' && columnSchema.defaultValue !== null && 'type' in columnSchema.defaultValue) {
							// It's an AST.Expression
							compiler.compileExpression(columnSchema.defaultValue as AST.Expression, regDefaultValue);
						} else {
							// It's a literal SqlValue - use the helper
							compileLiteralValue(compiler, columnSchema.defaultValue, regDefaultValue);
						}

						compiler.emit(Opcode.SCopy, regDefaultValue, destReg, 0, null, 0, `Copy DEFAULT value for col ${i} (${columnSchema.name})`);

						// Check NOT NULL constraint on the *default* value
						if (columnSchema.notNull) {
							const regIsNullResult = compiler.allocateMemoryCells(1);
							const addrConstraintFail = compiler.allocateAddress();
							const addrConstraintOK = compiler.allocateAddress();
							const constraintContext = `${tableSchema.name}.${columnSchema.name} DEFAULT`;

							compiler.emit(Opcode.IsNull, regDefaultValue, regIsNullResult, 0, null, 0, `Check NULL ${constraintContext}`);
							compiler.emit(Opcode.IfTrue, regIsNullResult, addrConstraintFail, 0, null, 0, `Jump if NULL ${constraintContext}`);
							compiler.emit(Opcode.Goto, 0, addrConstraintOK, 0, null, 0, 'Skip violation');
							compiler.resolveAddress(addrConstraintFail);
							compiler.emit(Opcode.ConstraintViolation, 0, 0, 0, `NOT NULL constraint failed (using DEFAULT): ${constraintContext}`, 0, `THROW ${constraintContext}`);
							compiler.resolveAddress(addrConstraintOK);
							// Consider freeing regDefaultValue and regIsNullResult if temp registers are used
						}
					} else {
						// No value provided and no DEFAULT value
						compiler.emit(Opcode.Null, 0, destReg, 0, null, 0, `Set NULL for omitted col ${i} (${columnSchema.name})`);

						// Check NOT NULL constraint if column is NOT NULL and has no DEFAULT
						if (columnSchema.notNull) {
							const addrConstraintFail = compiler.allocateAddress();
							const constraintContext = `${tableSchema.name}.${columnSchema.name} (no default)`;
							// We know the value is NULL, so directly emit the violation
							compiler.emit(Opcode.ConstraintViolation, 0, 0, 0, `NOT NULL constraint failed: ${constraintContext}`, 0, `THROW ${constraintContext}`);
							// This part of the code might technically be unreachable if ConstraintViolation halts,
							// but include for clarity or potential future changes where it might not halt.
							// compiler.emit(Opcode.Goto, 0, addrConstraintOK, 0, null, 0); // Skip if not needed
							// compiler.resolveAddress(addrConstraintOK);
						}
					}
				}
			}

			// Release registers used for provided values (if using temporary allocation)
			// valueRegisters.forEach(reg => compiler.freeTempRegister(reg)); // Uncomment if using temp registers

			const p4Update: P4Update = { onConflict: stmt.onConflict || ConflictResolution.ABORT, table: tableSchema, type: 'update' };
			compiler.emit(Opcode.VUpdate, tableSchema.columns.length + 1, regDataStart, regNewRowid, p4Update, 0, `VUpdate INSERT ${tableSchema.name}`);
		}
	} else if (stmt.select) { throw new SqliteError("INSERT ... SELECT compilation not implemented yet.", StatusCode.ERROR, undefined, stmt.select.loc?.start.line, stmt.select.loc?.start.column); }
	else { throw new SqliteError("INSERT statement missing VALUES or SELECT clause.", StatusCode.ERROR, undefined, stmt.loc?.start.line, stmt.loc?.start.column); }
	compiler.emit(Opcode.Close, cursor, 0, 0, null, 0, `Close ${tableSchema.name}`);
}

export function compileUpdateStatement(compiler: Compiler, stmt: AST.UpdateStmt): void {
	const tableSchema = compiler.db._findTable(stmt.table.name, stmt.table.schema);
	if (!tableSchema) { throw new SqliteError(`Table not found: ${stmt.table.schema || 'main'}.${stmt.table.name}`, StatusCode.ERROR, undefined, stmt.table.loc?.start.line, stmt.table.loc?.start.column); }
	if (!tableSchema.isVirtual || !tableSchema.vtabInstance || !tableSchema.vtabModule?.xUpdate) { throw new SqliteError(`Table ${tableSchema.name} is not a virtual table supporting UPDATE`, StatusCode.ERROR, undefined, stmt.table.loc?.start.line, stmt.table.loc?.start.column); }

	const cursor = compiler.allocateCursor();
	const p4Vtab: P4Vtab = { type: 'vtab', tableSchema };
	compiler.emit(Opcode.OpenRead, cursor, 0, 0, p4Vtab, 0, `OpenRead for UPDATE ${tableSchema.name}`);
	// --- Pass WHERE clause and undefined ORDER BY ---
	compiler.planTableAccess(cursor, tableSchema, stmt, new Set()); // Pass the full statement
	// ---------------------------------------------
	const planningInfo = compiler.cursorPlanningInfo.get(cursor);

	const regTargetRowid = compiler.allocateMemoryCells(1);
	const addrEOF = compiler.allocateAddress();
	const addrLoopStart = compiler.allocateAddress();
	const addrContinueUpdate = compiler.allocateAddress();

	let regArgsStart = 0;
	let filterP4: any = { idxNum: 0, idxStr: null, nArgs: 0 };
	if (planningInfo && planningInfo.idxNum !== 0) {
		const argsToCompile: { constraintIdx: number, expr: AST.Expression }[] = [];
		planningInfo.usage.forEach((usage, constraintIdx) => {
			if (usage.argvIndex > 0) {
				const expr = planningInfo.constraintExpressions?.get(constraintIdx);
				if (!expr) throw new SqliteError(`Internal error: Missing expression for constraint ${constraintIdx} used in UPDATE VFilter`, StatusCode.INTERNAL);
				while (argsToCompile.length < usage.argvIndex) { argsToCompile.push(null as any); }
				argsToCompile[usage.argvIndex - 1] = { constraintIdx, expr };
			}
		});
		const finalArgsToCompile = argsToCompile.filter(a => a !== null);
		if (finalArgsToCompile.length > 0) {
			regArgsStart = compiler.allocateMemoryCells(finalArgsToCompile.length);
			finalArgsToCompile.forEach((argInfo, i) => { compiler.compileExpression(argInfo.expr, regArgsStart + i /* Pass correlation/argMap? */); });
		}
		filterP4 = { idxNum: planningInfo.idxNum, idxStr: planningInfo.idxStr, nArgs: finalArgsToCompile.length };
	}
	compiler.emit(Opcode.VFilter, cursor, addrEOF, regArgsStart, filterP4, 0, `Filter for UPDATE ${tableSchema.name} (Plan: ${planningInfo?.idxNum})`);
	compiler.resolveAddress(addrLoopStart);

	compileUnhandledWhereConditions(compiler, stmt.where, [cursor], addrContinueUpdate /* Pass correlation/argMap? */);

	// Get Rowid for the current row matched by WHERE
	compiler.emit(Opcode.VRowid, cursor, regTargetRowid, 0, null, 0, "Get Rowid for UPDATE target");

	// --- Calculate new values for SET assignments ---
	const assignmentRegs = new Map<number, number>();
	for (const assignment of stmt.assignments) {
		const colNameLower = assignment.column.toLowerCase();
		const colIndex = tableSchema.columnIndexMap.get(colNameLower);
		if (colIndex === undefined) { throw new SqliteError(`Column '${assignment.column}' not found in table '${tableSchema.name}'`, StatusCode.ERROR, undefined, stmt.loc?.start.line, stmt.loc?.start.column); }
		if (assignmentRegs.has(colIndex)) { throw new SqliteError(`Column '${assignment.column}' specified more than once in SET clause`, StatusCode.ERROR, undefined, stmt.loc?.start.line, stmt.loc?.start.column); }
		const valueReg = compiler.allocateMemoryCells(1);
		compiler.compileExpression(assignment.value, valueReg /* Pass correlation/argMap? */);

		// Check NOT NULL constraint if applicable
		const columnSchema = tableSchema.columns[colIndex];
		if (columnSchema.notNull) {
			// Use allocateMemoryCells, no explicit freeing
			const regIsNullResult = compiler.allocateMemoryCells(1);
			const addrConstraintFail = compiler.allocateAddress();
			const addrConstraintOK = compiler.allocateAddress();
			const constraintContext = `${tableSchema.name}.${columnSchema.name}`;

			// Is value in valueReg NULL? Store result in regIsNullResult
			compiler.emit(Opcode.IsNull, valueReg, regIsNullResult, 0, null, 0, `Check NULL ${constraintContext}`);
			// If regIsNullResult is TRUE (value was NULL), jump to failure handler
			compiler.emit(Opcode.IfTrue, regIsNullResult, addrConstraintFail, 0, null, 0, `Jump if NULL ${constraintContext}`);

			// If we got here, value was NOT NULL. Jump over the failure handler.
			compiler.emit(Opcode.Goto, 0, addrConstraintOK, 0, null, 0, 'Skip violation');

			// --- Failure Handler ---
			compiler.resolveAddress(addrConstraintFail);
			compiler.emit(Opcode.ConstraintViolation, 0, 0, 0, `NOT NULL constraint failed: ${constraintContext}`, 0, `THROW ${constraintContext}`);
			// --- End Failure Handler ---

			compiler.resolveAddress(addrConstraintOK); // Continue execution here
			// No freeTempRegister call needed
		}

		assignmentRegs.set(colIndex, valueReg);
	}

	// --- Gather Full Proposed Row & Compile CHECK constraints ---
	if (tableSchema.checkConstraints && tableSchema.checkConstraints.length > 0) {
		// Map to hold registers for ALL columns (new or old values)
		const updateValueRegisters = new Map<number, number>();

		// Populate with SET values and fetch old values for non-SET columns
		for (let i = 0; i < tableSchema.columns.length; i++) {
			if (assignmentRegs.has(i)) {
				// Use the already calculated new value
				updateValueRegisters.set(i, assignmentRegs.get(i)!);
			} else {
				// Fetch the old value for columns not being updated
				const regOldValue = compiler.allocateMemoryCells(1);
				compiler.emit(Opcode.VColumn, cursor, i, regOldValue, 0, 0, `Get old value ${tableSchema.columns[i].name}`);
				updateValueRegisters.set(i, regOldValue);
			}
		}

		// Create the argument map for CHECK constraints: string(colIndex) -> register
		const checkArgMap: Map<string, number> = new Map<string, number>();
		updateValueRegisters.forEach((reg, index) => {
			checkArgMap.set(`${index}`, reg);
		});

		// Now compile each CHECK constraint using the combined values
		tableSchema.checkConstraints.forEach((constraint, idx) => {
			const checkExpr = constraint.expr;
			const constraintName = constraint.name ?? `check_${idx}`;
			const constraintContext = `CHECK constraint ${constraintName} on ${tableSchema.name}`;

			const regCheckResult = compiler.allocateMemoryCells(1);
			const addrCheckOK = compiler.allocateAddress();

			compiler.compileExpression(checkExpr, regCheckResult, undefined, undefined, checkArgMap);
			compiler.emit(Opcode.IfTrue, regCheckResult, addrCheckOK, 0, null, 0, `If true, skip violation ${constraintName}`);

			// Failure Handler
			const errorMsg = `CHECK constraint failed: ${constraintName}`;
			compiler.emit(Opcode.ConstraintViolation, 0, 0, 0, errorMsg, 0, `THROW ${constraintName}`);

			compiler.resolveAddress(addrCheckOK);
		});
	}
	// --- End CHECK constraints ---

	// Prepare arguments for VUpdate (using only the *changed* columns)
	const updateP4: P4Update = {
		onConflict: stmt.onConflict || ConflictResolution.ABORT,
		table: tableSchema,
		type: 'update'
	};
	const numTableCols = tableSchema.columns.length;
	const regUpdateDataStart = compiler.allocateMemoryCells(numTableCols + 1);
	compiler.emit(Opcode.SCopy, regTargetRowid, regUpdateDataStart, 0, null, 0, "Copy Rowid for VUpdate");
	for (let i = 0; i < numTableCols; i++) {
		const destReg = regUpdateDataStart + 1 + i;
		if (assignmentRegs.has(i)) {
			const sourceReg = assignmentRegs.get(i)!;
			compiler.emit(Opcode.SCopy, sourceReg, destReg, 0, null, 0, `Copy NEW value for col ${i}`);
		} else {
			compiler.emit(Opcode.VColumn, cursor, i, destReg, 0, 0, `Get OLD value for col ${i}`);
		}
	}

	compiler.emit(Opcode.VUpdate, numTableCols + 1, regUpdateDataStart, 0, updateP4, 0, `VUpdate UPDATE ${tableSchema.name}`);

	compiler.resolveAddress(addrContinueUpdate /* Pass correlation/argMap? */);
	compiler.emit(Opcode.VNext, cursor, addrEOF, 0, null, 0, "Advance to next row for UPDATE");
	compiler.emit(Opcode.Goto, 0, addrLoopStart, 0, null, 0, "Loop back for next UPDATE");

	compiler.resolveAddress(addrEOF);
	compiler.emit(Opcode.Close, cursor, 0, 0, null, 0, `Close ${tableSchema.name}`);
}

export function compileDeleteStatement(compiler: Compiler, stmt: AST.DeleteStmt): void {
	const tableSchema = compiler.db._findTable(stmt.table.name, stmt.table.schema);
	if (!tableSchema) { throw new SqliteError(`Table not found: ${stmt.table.schema || 'main'}.${stmt.table.name}`, StatusCode.ERROR, undefined, stmt.table.loc?.start.line, stmt.table.loc?.start.column); }
	if (!tableSchema.isVirtual || !tableSchema.vtabInstance || !tableSchema.vtabModule?.xUpdate) { throw new SqliteError(`Table ${tableSchema.name} is not a virtual table supporting DELETE`, StatusCode.ERROR, undefined, stmt.table.loc?.start.line, stmt.table.loc?.start.column); }

	const cursor = compiler.allocateCursor();
	const p4Vtab: P4Vtab = { type: 'vtab', tableSchema };
	compiler.emit(Opcode.OpenRead, cursor, 0, 0, p4Vtab, 0, `OpenRead for DELETE ${tableSchema.name}`);
	// --- Pass WHERE clause and undefined ORDER BY ---
	compiler.planTableAccess(cursor, tableSchema, stmt, new Set()); // Pass the full statement
	// ---------------------------------------------
	const planningInfo = compiler.cursorPlanningInfo.get(cursor);

	const regRowid = compiler.allocateMemoryCells(1);
	const addrEOF = compiler.allocateAddress();
	const addrLoopStart = compiler.allocateAddress();
	const addrContinueDelete = compiler.allocateAddress();

	let regArgsStart = 0;
	let filterP4: any = { idxNum: 0, idxStr: null, nArgs: 0 };
	if (planningInfo && planningInfo.idxNum !== 0) {
		const argsToCompile: { constraintIdx: number, expr: AST.Expression }[] = [];
		planningInfo.usage.forEach((usage, constraintIdx) => {
			if (usage.argvIndex > 0) {
				const expr = planningInfo.constraintExpressions?.get(constraintIdx);
				if (!expr) throw new SqliteError(`Internal error: Missing expression for constraint ${constraintIdx} used in DELETE VFilter`, StatusCode.INTERNAL);
				while (argsToCompile.length < usage.argvIndex) { argsToCompile.push(null as any); }
				argsToCompile[usage.argvIndex - 1] = { constraintIdx, expr };
			}
		});
		const finalArgsToCompile = argsToCompile.filter(a => a !== null);
		if (finalArgsToCompile.length > 0) {
			regArgsStart = compiler.allocateMemoryCells(finalArgsToCompile.length);
			finalArgsToCompile.forEach((argInfo, i) => { compiler.compileExpression(argInfo.expr, regArgsStart + i /* Pass correlation/argMap? */); });
		}
		filterP4 = { idxNum: planningInfo.idxNum, idxStr: planningInfo.idxStr, nArgs: finalArgsToCompile.length };
	}
	compiler.emit(Opcode.VFilter, cursor, addrEOF, regArgsStart, filterP4, 0, `Filter for DELETE ${tableSchema.name} (Plan: ${planningInfo?.idxNum})`);
	compiler.resolveAddress(addrLoopStart);

	compileUnhandledWhereConditions(compiler, stmt.where, [cursor], addrContinueDelete /* Pass correlation/argMap? */);

	compiler.emit(Opcode.VRowid, cursor, regRowid, 0, null, 0, "Get Rowid for DELETE");
	const p4Update = { onConflict: ConflictResolution.ABORT, table: tableSchema, type: 'update' };
	compiler.emit(Opcode.VUpdate, 1, regRowid, 0, p4Update, 0, `VUpdate DELETE ${tableSchema.name}`);

	compiler.resolveAddress(addrContinueDelete /* Pass correlation/argMap? */);
	compiler.emit(Opcode.VNext, cursor, addrEOF, 0, null, 0, "Advance to next row for DELETE");
	compiler.emit(Opcode.Goto, 0, addrLoopStart, 0, null, 0, "Loop back for next DELETE");

	compiler.resolveAddress(addrEOF);
	compiler.emit(Opcode.Close, cursor, 0, 0, null, 0, `Close ${tableSchema.name}`);
}

export function compileRollbackStatement(compiler: Compiler, stmt: AST.RollbackStmt): void {
	if (stmt.savepoint) {
		const savepointName = compiler.addConstant(stmt.savepoint);
		compiler.emit(Opcode.Savepoint, 0, 0, 0, savepointName, 0, `ROLLBACK TO ${stmt.savepoint}`);
		compiler.emit(Opcode.VRollbackTo, 0, 0, 0, savepointName, 0, `VRollbackTo ${stmt.savepoint}`);
	} else {
		compiler.emit(Opcode.VRollback, 0, 0, 0, null, 0, "ROLLBACK");
	}
}

export function compileSavepointStatement(compiler: Compiler, stmt: AST.SavepointStmt): void {
	const savepointName = compiler.addConstant(stmt.name);
	compiler.emit(Opcode.Savepoint, 1, 0, 0, savepointName, 0, `SAVEPOINT ${stmt.name}`);
	compiler.emit(Opcode.VSavepoint, 0, 0, 0, savepointName, 0, `VSavepoint ${stmt.name}`);
}

export function compileReleaseStatement(compiler: Compiler, stmt: AST.ReleaseStmt): void {
	if (!stmt.savepoint) {
		throw new SqliteError("RELEASE statement requires a savepoint name.", StatusCode.ERROR, undefined, stmt.loc?.start.line, stmt.loc?.start.column);
	}
	const savepointName = compiler.addConstant(stmt.savepoint);
	compiler.emit(Opcode.Savepoint, 2, 0, 0, savepointName, 0, `RELEASE ${stmt.savepoint}`);
	compiler.emit(Opcode.VRelease, 0, 0, 0, savepointName, 0, `VRelease ${stmt.savepoint}`);
}
