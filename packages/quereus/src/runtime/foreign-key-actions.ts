import type { Database } from '../core/database.js';
import type { TableSchema, ForeignKeyConstraintSchema } from '../schema/table.js';
import type { Row, SqlValue } from '../common/types.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import { createLogger } from '../common/logger.js';
import { expressionToString } from '../emit/ast-stringify.js';

const log = createLogger('runtime:fk-actions');

/**
 * Resolves referenced column indices in the parent table from a FK schema.
 * Uses stored column names or falls back to the parent's primary key.
 */
function resolveParentColumnIndices(
	fk: ForeignKeyConstraintSchema,
	parentSchema: TableSchema,
): number[] {
	const fkWithNames = fk as ForeignKeyConstraintSchema & { _referencedColumnNames?: string[] };
	const refColNames = fkWithNames._referencedColumnNames;

	if (refColNames && refColNames.length > 0) {
		return refColNames.map(name => {
			const idx = parentSchema.columnIndexMap.get(name.toLowerCase());
			if (idx === undefined) {
				throw new QuereusError(
					`Referenced column '${name}' not found in table '${parentSchema.name}'`,
					StatusCode.ERROR
				);
			}
			return idx;
		});
	}
	return parentSchema.primaryKeyDefinition.map(pk => pk.index);
}

/**
 * Executes cascading foreign key actions when a parent row is deleted or updated.
 *
 * @param db Database instance
 * @param parentTable Parent table schema being mutated
 * @param operation 'delete' or 'update'
 * @param oldRow The old row values from the parent table
 * @param newRow The new row values (undefined for delete)
 * @param visitedTables Set of table names already visited (for cycle detection)
 */
export async function executeForeignKeyActions(
	db: Database,
	parentTable: TableSchema,
	operation: 'delete' | 'update',
	oldRow: Row,
	newRow?: Row,
	visitedTables?: Set<string>,
): Promise<void> {
	if (!db.options.getBooleanOption('foreign_keys')) return;

	const visited = visitedTables ?? new Set<string>();
	const parentKey = `${parentTable.schemaName}.${parentTable.name}`.toLowerCase();

	if (visited.has(parentKey)) {
		throw new QuereusError(
			`Foreign key cascade cycle detected involving table '${parentTable.name}'`,
			StatusCode.CONSTRAINT
		);
	}
	visited.add(parentKey);

	try {
		// Find all child tables with FKs referencing this parent
		for (const schema of db.schemaManager._getAllSchemas()) {
			for (const childTable of schema.getAllTables()) {
				if (!childTable.foreignKeys) continue;

				for (const fk of childTable.foreignKeys) {
					if (fk.referencedTable.toLowerCase() !== parentTable.name.toLowerCase()) continue;

					const action = operation === 'delete' ? fk.onDelete : fk.onUpdate;

					// RESTRICT and NO ACTION are handled by constraint checks, not actions
					if (action === 'restrict' || action === 'noAction') continue;

					const parentColIndices = resolveParentColumnIndices(fk, parentTable);
					if (parentColIndices.length !== fk.columns.length) continue;

					// Get old parent values for the referenced columns
					const oldParentValues = parentColIndices.map(idx => oldRow[idx]);

					// Skip if any old value is NULL (NULLs don't participate in FK matching)
					if (oldParentValues.some(v => v === null || v === undefined)) continue;

					await executeSingleFKAction(
						db, childTable, fk, action, parentTable, parentColIndices,
						oldParentValues, operation === 'update' ? newRow : undefined,
						visited
					);
				}
			}
		}
	} finally {
		visited.delete(parentKey);
	}
}

async function executeSingleFKAction(
	db: Database,
	childTable: TableSchema,
	fk: ForeignKeyConstraintSchema,
	action: 'cascade' | 'setNull' | 'setDefault',
	parentTable: TableSchema,
	parentColIndices: number[],
	oldParentValues: SqlValue[],
	newRow: Row | undefined,
	visited: Set<string>,
): Promise<void> {
	const childColNames = fk.columns.map(idx => childTable.columns[idx].name);
	const whereClause = childColNames
		.map(name => `"${name}" = ?`)
		.join(' AND ');

	switch (action) {
		case 'cascade': {
			if (newRow === undefined) {
				// CASCADE DELETE: delete matching child rows
				const sql = `DELETE FROM "${childTable.name}" WHERE ${whereClause}`;
				log('CASCADE DELETE: %s with params %o', sql, oldParentValues);
				await db._execWithinTransaction(sql, oldParentValues);
			} else {
				// CASCADE UPDATE: update child FK columns to new parent values
				const newParentValues = parentColIndices.map(idx => newRow[idx]);
				const setClauses = childColNames
					.map(name => `"${name}" = ?`)
					.join(', ');
				const whereParamsClause = childColNames
					.map(name => `"${name}" = ?`)
					.join(' AND ');
				const sql = `UPDATE "${childTable.name}" SET ${setClauses} WHERE ${whereParamsClause}`;
				const params = [...newParentValues, ...oldParentValues];
				log('CASCADE UPDATE: %s with params %o', sql, params);
				await db._execWithinTransaction(sql, params);
			}
			break;
		}
		case 'setNull': {
			const setClauses = childColNames.map(name => `"${name}" = NULL`).join(', ');
			const sql = `UPDATE "${childTable.name}" SET ${setClauses} WHERE ${whereClause}`;
			log('SET NULL: %s with params %o', sql, oldParentValues);
			await db._execWithinTransaction(sql, oldParentValues);
			break;
		}
		case 'setDefault': {
			const setClauses = childColNames.map((name, i) => {
				const col = childTable.columns[fk.columns[i]];
				const defaultVal = col.defaultValue;
				if (defaultVal === null || defaultVal === undefined) {
					return `"${name}" = NULL`;
				}
				// defaultValue is always an AST Expression — stringify it
				return `"${name}" = (${expressionToString(defaultVal)})`;
			}).join(', ');
			const sql = `UPDATE "${childTable.name}" SET ${setClauses} WHERE ${whereClause}`;
			log('SET DEFAULT: %s with params %o', sql, oldParentValues);
			await db._execWithinTransaction(sql, oldParentValues);
			break;
		}
	}
}
