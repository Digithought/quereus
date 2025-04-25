import { Opcode } from '../common/constants';
import type { Compiler } from './compiler';
import { createDefaultColumnSchema } from '../schema/column';
import { buildColumnIndexMap } from '../schema/table';
import type { TableSchema } from '../schema/table';
import type { P4SortKey } from '../vdbe/instruction';

export function createEphemeralSchemaHelper(
	compiler: Compiler,
	cursorIdx: number,
	numCols: number,
	sortKey?: P4SortKey
): TableSchema {
	const columns = Array.from({ length: numCols }, (_, i) => createDefaultColumnSchema(`eph_col${i}`));
	let pkDef: ReadonlyArray<{ index: number; desc: boolean }> = [];
	if (sortKey) {
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
		checkConstraints: [],
		columns: Object.freeze(columns),
		columnIndexMap: Object.freeze(buildColumnIndexMap(columns)),
		primaryKeyDefinition: pkDef,
		isVirtual: true, // Ephemeral tables are treated like virtual tables for VDBE interaction
		isWithoutRowid: false,
		isStrict: false,
		isView: false,
	};

	// Register the schema with the compiler
	compiler.tableSchemas.set(cursorIdx, tableSchema);
	compiler.ephemeralTables.set(cursorIdx, tableSchema); // Track it specifically as ephemeral
	return tableSchema;
}

export function closeCursorsUsedBySelectHelper(compiler: Compiler, cursors: number[]): void {
	cursors.forEach(cursorIdx => {
		compiler.emit(Opcode.Close, cursorIdx, 0, 0, null, 0, `Close inner cursor ${cursorIdx}`);
		// Clean up compiler state associated with the cursor
		compiler.tableSchemas.delete(cursorIdx);
		compiler.ephemeralTables.delete(cursorIdx);
		compiler.cursorPlanningInfo.delete(cursorIdx);
        // Remove alias mapping if present
        for (const [alias, cIdx] of compiler.tableAliases.entries()) {
            if (cIdx === cursorIdx) {
                compiler.tableAliases.delete(alias);
                // Assuming an alias maps to only one cursor at a time within a scope
                break;
            }
        }
	});
}
