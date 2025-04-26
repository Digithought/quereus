import { SqlDataType } from '../common/constants.js';
import { Opcode } from '../vdbe/opcodes.js';
import { SqliteError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import type { Compiler } from './compiler.js';
import * as AST from '../parser/ast.js';
import type { P4Vtab } from '../vdbe/instruction.js';
import type { BaseModuleConfig } from '../vtab/module.js';
import type { SqlValue } from '../common/types.js';
import type { P4OpenTvf } from '../vdbe/instruction.js';

// Local config interfaces (mirroring ddl.ts for now)
interface MemoryTableConfig extends BaseModuleConfig {
	columns: { name: string, type: SqlDataType, collation?: string }[];
	primaryKey?: ReadonlyArray<{ index: number; desc: boolean }>;
	readOnly?: boolean;
}
interface JsonConfig extends BaseModuleConfig {
	jsonSource: SqlValue;
	rootPath?: SqlValue;
}

// --- FROM Clause Compilation --- //

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

			// VDBE OpenRead/OpenWrite will handle xConnect, just pass schema in P4
			const p4Vtab: P4Vtab = { type: 'vtab', tableSchema };
			compiler.emit(Opcode.OpenRead, cursor, 0, 0, p4Vtab, 0, `Open VTab ${source.alias || tableName}`);
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

			// --- Compile Arguments into Registers ---
			const numArgs = source.args.length;
			const argBaseReg = compiler.allocateMemoryCells(numArgs); // Allocate contiguous registers for args
			for (let i = 0; i < numArgs; i++) {
				const argExpr = source.args[i];
				const targetReg = argBaseReg + i;
				// Compile the argument expression, result goes into targetReg
				// Assume correlation/having context are not relevant for TVF args here
				compiler.compileExpression(argExpr, targetReg);
			}
			// ---------------------------------------

			const cursor = compiler.allocateCursor();
			openedCursors.push(cursor);
			const lookupName = (source.alias || funcName).toLowerCase();

			// We need to store the schema and alias association *after* OpenTvf runs
			// This mapping is done within the OpenTvf handler now.
			// compiler.tableSchemas.set(cursor, instance.tableSchema); // Moved to OpenTvf handler
			if (compiler.tableAliases.has(lookupName) || currentLevelAliases.has(lookupName)) {
				throw new SqliteError(`Duplicate table name or alias: ${lookupName}`, StatusCode.ERROR, undefined, source.loc?.start.line, source.loc?.start.column);
			}
			compiler.tableAliases.set(lookupName, cursor); // Keep alias mapping
			currentLevelAliases.set(lookupName, cursor); // Keep alias mapping

			// Emit the new OpenTvf opcode
			// P1: Cursor index
			// P2: Base register of arguments
			// P3: Number of arguments
			// P4: P4OpenTvf object containing moduleName and alias
			// P5: Unused (0)
			const p4: P4OpenTvf = { type: 'opentvf', moduleName: funcName, alias: lookupName };
			compiler.emit(Opcode.OpenTvf, cursor, argBaseReg, numArgs, p4, 0, `Open TVF ${lookupName}`);

		} else if (source.type === 'subquerySource') {
			// Handle Subquery in FROM
			const subquery = source.subquery;
			const alias = source.alias.toLowerCase();

			if (compiler.tableAliases.has(alias) || currentLevelAliases.has(alias)) {
				throw new SqliteError(`Duplicate table name or alias: ${alias}`, StatusCode.ERROR, undefined, source.loc?.start.line, source.loc?.start.column);
			}

			// Subqueries in FROM are often treated like ephemeral tables or views.
			// The compilation of the subquery itself will generate the necessary
			// instructions to populate a temporary result set.
			// We need to allocate a cursor for this result set.

			// Option 1: Compile subquery directly into an ephemeral table
			// This is similar to how non-recursive CTEs might be handled.
			const { resultBaseReg, numCols, columnMap } = compiler.compileSelectCore(subquery, compiler.outerCursors); // Pass outer cursors if needed

			// Create an ephemeral table to hold the subquery results
			const cursor = compiler.allocateCursor();
			openedCursors.push(cursor);
			const ephemeralSchema = compiler.createEphemeralSchema(cursor, numCols); // Create schema based on select core result
			compiler.tableSchemas.set(cursor, ephemeralSchema);
			compiler.tableAliases.set(alias, cursor);
			currentLevelAliases.set(alias, cursor);

			// Emit instructions to populate the ephemeral table
			// 1. Open the ephemeral table for writing (use a dedicated opcode or flag?)
			//    For now, assuming OpenWrite works, but needs check
			const p4EphemWrite: P4Vtab = { type: 'vtab', tableSchema: ephemeralSchema };
			compiler.emit(Opcode.OpenWrite, cursor, 0, 0, p4EphemWrite, 0, `Open Ephemeral for Subquery ${alias}`);

			// 2. Execute the subquery logic (already emitted by compileSelectCore)
			//    It should end by yielding rows to a target. We need to redirect this
			//    to insert into the ephemeral table.
			//    This part is tricky. compileSelectCore typically prepares for result rows.
			//    Maybe compileSelectCore needs a mode to target an ephemeral table?

			// *** Revisit Subquery Compilation Strategy ***
			// A simpler approach might be needed, possibly involving subroutines
			// or direct iteration without materializing fully beforehand unless necessary.
			// For now, placeholder - this needs deeper changes.
			console.warn(`FROM clause subquery compilation for '${alias}' is incomplete.`);
			// Placeholder: Emit a Noop or rewind for now
			compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, `Placeholder for subquery ${alias} execution`);
			// Need to ensure the cursor is positioned correctly after population.
			// compiler.emit(Opcode.Rewind, cursor, compiler.allocateAddress(), 0); // Rewind after populating

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
