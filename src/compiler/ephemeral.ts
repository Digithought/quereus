import { Opcode } from '../vdbe/opcodes.js';
import type { Compiler } from './compiler.js';
import { createDefaultColumnSchema } from '../schema/column.js';
import { buildColumnIndexMap } from '../schema/table.js';
import type { TableSchema } from '../schema/table.js';
import type { P4SortKey } from '../vdbe/instruction.js';
import { MemoryTableModule } from '../vtab/memory/module.js';
import type { BaseModuleConfig } from '../vtab/module.js';
import type { MemoryTable } from '../vtab/memory/table.js';
import { MisuseError, SqliteError } from '../common/errors.js';
import { StatusCode } from '../common/constants.js';

/**
 * Creates an internal MemoryTable instance for ephemeral use (CTEs, sorters, subqueries)
 * and registers its schema with the compiler.
 *
 * This function only creates the schema and instance - it doesn't emit VDBE instructions
 * to open the cursor. The VDBE needs to use the stored instance from compiler.ephemeralTableInstances.
 *
 * @param compiler The compiler instance managing the compilation
 * @param cursorIdx The cursor index to associate with this table
 * @param numCols Number of columns in the ephemeral table
 * @param sortKey Optional sort key configuration for ordered tables
 * @returns The created table schema
 */
export function createEphemeralTableHelper(
	compiler: Compiler,
	cursorIdx: number,
	numCols: number,
	sortKey?: P4SortKey
): TableSchema {
	const moduleInfo = compiler.db._getVtabModule('memory');
	if (!moduleInfo || !(moduleInfo.module instanceof MemoryTableModule)) {
		throw new SqliteError("MemoryTableModule not registered or found.", StatusCode.INTERNAL);
	}
	const memoryModule = moduleInfo.module as MemoryTableModule;

	const columnsConfig = Array.from({ length: numCols }, (_, i) => ({
		name: `eph_col${i}`,
		type: 'TEXT',
		collation: 'BINARY'
	}));

	let primaryKeyConfig: ReadonlyArray<{ index: number; desc: boolean }> | undefined = undefined;
	if (sortKey) {
		sortKey.keyIndices.forEach((keyIndex, i) => {
			if (keyIndex >= 0 && keyIndex < columnsConfig.length && sortKey.collations?.[i]) {
				columnsConfig[keyIndex].collation = sortKey.collations[i]!;
			}
		});
		primaryKeyConfig = Object.freeze(sortKey.keyIndices.map((idx, i) => ({ index: idx, desc: sortKey.directions[i] })));
	}

	const config: BaseModuleConfig & {
		columns: { name: string, type: string, collation?: string }[];
		primaryKey?: ReadonlyArray<{ index: number; desc: boolean }>;
		readOnly?: boolean;
	} = {
		columns: columnsConfig,
		primaryKey: primaryKeyConfig,
		readOnly: false,
	};

	const ephemeralTableName = `_ephemeral_${cursorIdx}_${Date.now()}`;
	let tableInstance: MemoryTable;
	try {
		tableInstance = memoryModule.xCreate(
			compiler.db,
			moduleInfo.auxData,
			'memory',
			'temp',
			ephemeralTableName,
			config
		);
	} catch (e) {
		console.error("Failed to create internal MemoryTable instance:", e);
		const msg = e instanceof Error ? e.message : String(e);
		throw new SqliteError(`Internal error creating ephemeral table: ${msg}`, StatusCode.INTERNAL);
	}

	const tableSchema = tableInstance.tableSchema;
	if (!tableSchema) {
		throw new SqliteError("Internal MemoryTable instance did not provide a schema.", StatusCode.INTERNAL);
	}

	(tableSchema as any).schemaName = 'temp';
	(tableSchema as any).isTemporary = true;

	compiler.tableSchemas.set(cursorIdx, tableSchema);
	compiler.ephemeralTableInstances.set(cursorIdx, tableInstance);

	console.log(`Created ephemeral table instance '${ephemeralTableName}' for cursor ${cursorIdx}`);

	return tableSchema;
}

/**
 * Cleans up cursors and associated resources used by a SELECT statement
 *
 * @param compiler The compiler instance managing the compilation
 * @param cursors Array of cursor indices to close
 */
export function closeCursorsUsedBySelectHelper(compiler: Compiler, cursors: number[]): void {
	cursors.forEach(cursorIdx => {
		compiler.emit(Opcode.Close, cursorIdx, 0, 0, null, 0, `Close inner cursor ${cursorIdx}`);

		compiler.tableSchemas.delete(cursorIdx);
		compiler.cursorPlanningInfo.delete(cursorIdx);

		for (const [alias, cIdx] of compiler.tableAliases.entries()) {
			if (cIdx === cursorIdx) {
				compiler.tableAliases.delete(alias);
				break;
			}
		}

		const instance = compiler.ephemeralTableInstances?.get(cursorIdx);
		if (instance) {
			compiler.ephemeralTableInstances.delete(cursorIdx);
			console.log(`Cleaned up ephemeral table instance for cursor ${cursorIdx}`);
		}
	});
}
