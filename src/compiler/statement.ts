import { Opcode, ConflictResolution } from '../common/constants';
import { StatusCode } from '../common/types';
import { SqliteError } from '../common/errors';
import { type P4Vtab } from '../vdbe/instruction';
import type { Compiler } from './compiler';
import type * as AST from '../parser/ast';
import { compileUnhandledWhereConditions } from './helpers';

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
			for (let i = 0; i < numCols; i++) {
				const schemaColIndex = targetColumnIndices[i];
				compiler.compileExpression(valueRow[i], regDataStart + 1 + schemaColIndex);
			}

			const p4Update = { onConflict: stmt.onConflict || ConflictResolution.ABORT, table: tableSchema };
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

	const regRowid = compiler.allocateMemoryCells(1);
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

	const colNameToIndexMap = new Map<string, number>();
	tableSchema.columns.forEach((col, index) => { colNameToIndexMap.set(col.name.toLowerCase(), index); });
	const assignmentRegs = new Map<number, number>();
	const assignedColumnIndices = new Set<number>();
	for (const assignment of stmt.assignments) {
		const colNameLower = assignment.column.toLowerCase();
		const colIndex = colNameToIndexMap.get(colNameLower);
		if (colIndex === undefined) { throw new SqliteError(`Column '${assignment.column}' not found in table '${tableSchema.name}'`, StatusCode.ERROR, undefined, stmt.loc?.start.line, stmt.loc?.start.column); }
		if (assignedColumnIndices.has(colIndex)) { throw new SqliteError(`Column '${assignment.column}' specified more than once in SET clause`, StatusCode.ERROR, undefined, stmt.loc?.start.line, stmt.loc?.start.column); }
		const valueReg = compiler.allocateMemoryCells(1);
		compiler.compileExpression(assignment.value, valueReg /* Pass correlation/argMap? */);
		assignmentRegs.set(colIndex, valueReg);
		assignedColumnIndices.add(colIndex);
	}

	compiler.emit(Opcode.VRowid, cursor, regRowid, 0, null, 0, "Get Rowid for UPDATE");
	const numTableCols = tableSchema.columns.length;
	const regUpdateDataStart = compiler.allocateMemoryCells(numTableCols + 1);
	compiler.emit(Opcode.SCopy, regRowid, regUpdateDataStart, 0, null, 0, "Copy Rowid for VUpdate");
	for (let i = 0; i < numTableCols; i++) {
		const destReg = regUpdateDataStart + 1 + i;
		if (assignedColumnIndices.has(i)) {
			const sourceReg = assignmentRegs.get(i)!;
			compiler.emit(Opcode.SCopy, sourceReg, destReg, 0, null, 0, `Copy NEW value for col ${i}`);
		} else {
			compiler.emit(Opcode.VColumn, cursor, i, destReg, 0, 0, `Get OLD value for col ${i}`);
		}
	}

	const p4Update = { onConflict: stmt.onConflict || ConflictResolution.ABORT, table: tableSchema };
	compiler.emit(Opcode.VUpdate, numTableCols + 1, regUpdateDataStart, 0, p4Update, 0, `VUpdate UPDATE ${tableSchema.name}`);

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
	const p4Update = { onConflict: ConflictResolution.ABORT, table: tableSchema };
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
