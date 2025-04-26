import { SqlDataType } from '../common/constants.js';
import { Opcode } from '../vdbe/opcodes.js';
import { SqliteError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import type { Compiler } from './compiler.js';
import * as AST from '../parser/ast.js';
import type { P4Vtab } from '../vdbe/instruction.js';
import type { BaseModuleConfig } from '../vtab/module.js';
import type { SqlValue } from '../common/types.js';

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
			if (tableSchema.isVirtual) {
				const p4Vtab: P4Vtab = { type: 'vtab', tableSchema };
				compiler.emit(Opcode.OpenRead, cursor, 0, 0, p4Vtab, 0, `Open VTab ${source.alias || tableName}`);
			} else {
				throw new SqliteError("Regular tables not supported", StatusCode.ERROR, undefined, source.table.loc?.start.line, source.table.loc?.start.column);
			}
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

			const compiledArgs: string[] = [];
			for (const argExpr of source.args) {
				const tempReg = compiler.allocateMemoryCells(1);
				// Compile expression - assuming it doesn't involve complex logic needing VDBE execution here
				compiler.compileExpression(argExpr, tempReg);
				if (argExpr.type === 'literal') {
					if (argExpr.value === null || typeof argExpr.value === 'string') {
						compiledArgs.push(argExpr.value === null ? '' : argExpr.value);
					} else {
						throw new SqliteError(`Table-valued function arguments must be string literals (or NULL) for ${funcName}.`, StatusCode.ERROR, undefined, argExpr.loc?.start.line, argExpr.loc?.start.column);
					}
				} else if (argExpr.type === 'parameter') {
					throw new SqliteError(`Parameters not supported as arguments to table-valued functions like ${funcName} yet.`, StatusCode.ERROR, undefined, argExpr.loc?.start.line, argExpr.loc?.start.column);
				} else {
					throw new SqliteError(`Only literals supported as arguments to table-valued functions like ${funcName} yet.`, StatusCode.ERROR, undefined, argExpr.loc?.start.line, argExpr.loc?.start.column);
				}
			}

			const schemaName = 'main'; // TVFs usually don't have explicit schema in call
			const funcAlias = source.alias || funcName;
			// const argv: ReadonlyArray<string> = Object.freeze([funcName, schemaName, tableName, ...compiledArgs]);
			const moduleName = funcName;
			let options: BaseModuleConfig = {}; // Default for TVFs

			try {
				if (moduleName.toLowerCase() === 'json_each' || moduleName.toLowerCase() === 'json_tree') {
					// Expects 1 or 2 args: jsonSource, [rootPath]
					if (compiledArgs.length < 1 || compiledArgs.length > 2) {
						throw new Error(`${moduleName} requires 1 or 2 arguments (jsonSource, [rootPath])`);
					}
					options = {
						jsonSource: compiledArgs[0], // Assume string args are handled correctly later
						rootPath: compiledArgs[1]
					} as JsonConfig;
				} else {
					// Generic TVF module - pass empty config for now
					console.warn(`Compiler creating generic BaseModuleConfig for TVF module '${moduleName}'. Module may need specific argument parsing.`);
					options = {};
				}
			} catch (e: any) {
				throw new SqliteError(`Failed to parse arguments for TVF module '${moduleName}': ${e.message}`, StatusCode.ERROR, e instanceof Error ? e : undefined, source.name.loc?.start.line, source.name.loc?.start.column);
			}

			const instance = moduleInfo.module.xConnect(
				compiler.db,
				moduleInfo.auxData,
				moduleName, // Pass moduleName (funcName)
				schemaName, // Pass default schemaName
				funcAlias,  // Pass alias or funcName as tableName
				options     // Pass constructed options object
			);
			if (!instance || !instance.tableSchema) {
				throw new SqliteError(`Module ${funcName} xConnect did not return a valid table instance or schema.`, StatusCode.INTERNAL);
			}

			const cursor = compiler.allocateCursor();
			openedCursors.push(cursor);
			compiler.tableSchemas.set(cursor, instance.tableSchema);
			const lookupName = (source.alias || funcName).toLowerCase();
			if (compiler.tableAliases.has(lookupName) || currentLevelAliases.has(lookupName)) {
				throw new SqliteError(`Duplicate table name or alias: ${lookupName}`, StatusCode.ERROR, undefined, source.loc?.start.line, source.loc?.start.column);
			}
			compiler.tableAliases.set(lookupName, cursor);
			currentLevelAliases.set(lookupName, cursor);

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
