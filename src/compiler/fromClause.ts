import { SqlDataType } from '../common/constants.js';
import { Opcode } from '../vdbe/opcodes.js';
import { SqliteError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import type { Compiler } from './compiler.js';
import type { TableSchema } from '../schema/table.js';
import * as AST from '../parser/ast.js';
import type { P4Vtab } from '../vdbe/instruction.js';
import type { BaseModuleConfig } from '../vtab/module.js';
import type { SqlValue } from '../common/types.js';
import type { P4OpenTvf } from '../vdbe/instruction.js';
import { compileCommonTableExpression } from './cte.js'; // Import for on-demand compilation
import { createLogger } from '../common/logger.js';

const log = createLogger('compiler:from');
const warnLog = log.extend('warn');

// Local configuration interfaces for virtual tables
interface MemoryTableConfig extends BaseModuleConfig {
	columns: { name: string, type: SqlDataType, collation?: string }[];
	primaryKey?: ReadonlyArray<{ index: number; desc: boolean }>;
	readOnly?: boolean;
}

interface JsonConfig extends BaseModuleConfig {
	jsonSource: SqlValue;
	rootPath?: SqlValue;
}

/**
 * Compiles FROM clause sources by opening appropriate cursors and resolving aliases
 *
 * @param compiler The compiler instance
 * @param sources Array of FROM clause AST nodes
 * @returns Array of opened cursor indices
 */
export function compileFromCoreHelper(compiler: Compiler, sources: AST.FromClause[] | undefined): number[] {
	const openedCursors: number[] = [];
	if (!sources || sources.length === 0) {
		return openedCursors;
	}

	/**
	 * Recursively processes FROM clause sources and manages alias scope
	 */
	const openCursorsRecursive = (source: AST.FromClause, currentLevelAliases: Map<string, number>): void => {
		if (source.type === 'table') {
			const tableName = source.table.name;
			const schemaName = source.table.schema || 'main';
			const lookupName = (source.alias || tableName).toLowerCase();
			const cteNameLower = tableName.toLowerCase();

			// 1. Check if this is a CTE reference
			const cteInfo = compiler.cteMap.get(cteNameLower);
			if (cteInfo) {
				// --- Handle CTE Reference --- //
				let resolvedCursor: number | undefined;
				let resolvedSchema: TableSchema | undefined;

				if (cteInfo.strategy === 'materialized') {
					resolvedCursor = cteInfo.cursorIdx;
					resolvedSchema = cteInfo.schema;
					log(`Using PRE-materialized CTE '%s' (cursor %d) for alias '%s'`, cteNameLower, resolvedCursor, lookupName);
				} else if (cteInfo.strategy === 'view') {
					if (cteInfo.cursorIdx === undefined) {
						log(`Materializing VIEW CTE '%s' on first reference...`, cteNameLower);
						const isRecursiveContext = false;
						compileCommonTableExpression(compiler, cteInfo, isRecursiveContext);
						log(`Finished materializing VIEW CTE '%s' (cursor %d)`, cteNameLower, cteInfo.cursorIdx);
					} else {
						log(`Using ALREADY-materialized VIEW CTE '%s' (cursor %d) for alias '%s'`, cteNameLower, cteInfo.cursorIdx, lookupName);
					}
					resolvedCursor = cteInfo.cursorIdx;
					resolvedSchema = cteInfo.schema;
				}

				if (resolvedCursor === undefined || resolvedSchema === undefined) {
					throw new SqliteError(`Internal: Failed to resolve cursor/schema for CTE '${cteNameLower}' with strategy '${cteInfo.strategy}'`, StatusCode.INTERNAL);
				}

				openedCursors.push(resolvedCursor);
				compiler.tableSchemas.set(resolvedCursor, resolvedSchema);

				if (compiler.tableAliases.has(lookupName) || currentLevelAliases.has(lookupName)) {
					throw new SqliteError(`Duplicate table name or alias: ${lookupName}`, StatusCode.ERROR, undefined, source.loc?.start.line, source.loc?.start.column);
				}

				compiler.tableAliases.set(lookupName, resolvedCursor);
				currentLevelAliases.set(lookupName, resolvedCursor);
				return; // Handled CTE, exit this path
				// --- End Handle CTE Reference --- //
			}

			// 2. If not a CTE, check schema manager for regular table/view
			const tableSchema = compiler.db._findTable(tableName, schemaName);
			if (tableSchema) {
				// --- Handle Regular Table/View Found in Schema --- //
				const cursor = compiler.allocateCursor();
				openedCursors.push(cursor);
				compiler.tableSchemas.set(cursor, tableSchema);

				if (compiler.tableAliases.has(lookupName) || currentLevelAliases.has(lookupName)) {
					throw new SqliteError(`Duplicate table name or alias: ${lookupName}`, StatusCode.ERROR, undefined, source.loc?.start.line, source.loc?.start.column);
				}
				compiler.tableAliases.set(lookupName, cursor);
				currentLevelAliases.set(lookupName, cursor);

				const p4Vtab: P4Vtab = { type: 'vtab', tableSchema };
				compiler.emit(Opcode.OpenRead, cursor, 0, 0, p4Vtab, 0, `Open VTab ${source.alias || tableName}`);
				return; // Handled table from schema, exit this path
				// --- End Handle Regular Table/View --- //
			}

			// 3. If not CTE and not found in schema, throw error
			throw new SqliteError(`Table not found: ${schemaName}.${tableName}`, StatusCode.ERROR, undefined, source.table.loc?.start.line, source.table.loc?.start.column);

		} else if (source.type === 'join') {
			openCursorsRecursive(source.left, currentLevelAliases);
			openCursorsRecursive(source.right, currentLevelAliases);
		} else if (source.type === 'functionSource') {
			// Handle Table-Valued Function
			const funcName = source.name.name;
			const moduleInfo = compiler.db._getVtabModule(funcName);
			if (!moduleInfo) {
				throw new SqliteError(`Table-valued function or virtual table module not found: ${funcName}`, StatusCode.ERROR, undefined, source.name.loc?.start.line, source.name.loc?.start.column);
			}

			// Compile function arguments
			const numArgs = source.args.length;
			const argBaseReg = compiler.allocateMemoryCells(numArgs);
			for (let i = 0; i < numArgs; i++) {
				const argExpr = source.args[i];
				const targetReg = argBaseReg + i;
				compiler.compileExpression(argExpr, targetReg);
			}

			const cursor = compiler.allocateCursor();
			openedCursors.push(cursor);
			const lookupName = (source.alias || funcName).toLowerCase();

			if (compiler.tableAliases.has(lookupName) || currentLevelAliases.has(lookupName)) {
				throw new SqliteError(`Duplicate table name or alias: ${lookupName}`, StatusCode.ERROR, undefined, source.loc?.start.line, source.loc?.start.column);
			}
			compiler.tableAliases.set(lookupName, cursor);
			currentLevelAliases.set(lookupName, cursor);

			const p4: P4OpenTvf = { type: 'opentvf', moduleName: funcName, alias: lookupName };
			compiler.emit(Opcode.OpenTvf, cursor, argBaseReg, numArgs, p4, 0, `Open TVF ${lookupName}`);

		} else if (source.type === 'subquerySource') {
			// Handle Subquery in FROM
			const subquery = source.subquery;
			const alias = source.alias.toLowerCase();

			if (compiler.tableAliases.has(alias) || currentLevelAliases.has(alias)) {
				throw new SqliteError(`Duplicate table name or alias: ${alias}`, StatusCode.ERROR, undefined, source.loc?.start.line, source.loc?.start.column);
			}

			// Compile subquery into an ephemeral table
			const { numCols } = compiler.getSelectCoreStructure(subquery, compiler.outerCursors);

			// Create ephemeral table for results
			const cursor = compiler.allocateCursor();
			openedCursors.push(cursor);
			const ephemeralSchema = compiler.createEphemeralSchema(cursor, numCols);
			compiler.tableSchemas.set(cursor, ephemeralSchema);
			compiler.tableAliases.set(alias, cursor);
			currentLevelAliases.set(alias, cursor);

			const p4EphemWrite: P4Vtab = { type: 'vtab', tableSchema: ephemeralSchema };
			compiler.emit(Opcode.OpenWrite, cursor, 0, 0, p4EphemWrite, 0, `Open Ephemeral for Subquery ${alias}`);

			// TODO: This is incomplete - needs implementation to populate the ephemeral table
			warnLog(`FROM clause subquery compilation for '%s' is incomplete.`, alias);
			compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, `Placeholder for subquery ${alias} execution`);
		} else {
			throw new SqliteError(`Unsupported FROM clause type during cursor opening: ${(source as any).type}`, StatusCode.INTERNAL);
		}
	};

	// Process all top-level FROM clauses
	for (const source of sources) {
		const currentLevelAliases = new Map<string, number>();
		openCursorsRecursive(source, currentLevelAliases);
	}

	return openedCursors;
}
