import type { Database } from '../core/database.js';
import type { TableSchema, ForeignKeyConstraintSchema } from '../schema/table.js';
import { resolveReferencedColumns } from '../schema/table.js';
import type { Row, SqlValue } from '../common/types.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import { createLogger } from '../common/logger.js';
import { expressionToString, quoteIdentifier } from '../emit/ast-stringify.js';
import { sqlValuesEqual } from '../util/comparison.js';

const log = createLogger('runtime:fk-actions');

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

					const targetSchema = fk.referencedSchema ?? childTable.schemaName;
					if (targetSchema.toLowerCase() !== parentTable.schemaName.toLowerCase()) continue;

					const action = operation === 'delete' ? fk.onDelete : fk.onUpdate;

					// RESTRICT is handled by parent-side constraint checks, not actions
					if (action === 'restrict') continue;

					const parentColIndices = resolveReferencedColumns(fk, parentTable);
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

/**
 * Backend-agnostic RESTRICT pre-check fired by the runtime DML executor BEFORE
 * a parent DELETE or UPDATE hits the vtab. Mirrors the plan-time `NOT EXISTS`
 * synthesized by `buildParentSideFKChecks`, but uses a direct `select 1 ... limit 1`
 * against the child table so any vtab module sees a consistent enforcement path.
 *
 * The plan-time check remains in force; this runtime pass is defense-in-depth
 * for vtab modules where the embedded subquery's evaluation diverges from a
 * plain row scan (correlation handling, isolation snapshots, predicate
 * pushdown quirks, etc.).
 *
 * No-op when `foreign_keys` is off, when no FK references this parent table
 * with action `'restrict'`, when any old referenced value is NULL (MATCH SIMPLE),
 * or — for UPDATE — when no referenced parent column changed.
 */
export async function assertNoRestrictedChildrenForParentMutation(
	db: Database,
	parentTable: TableSchema,
	operation: 'delete' | 'update',
	oldRow: Row,
	newRow?: Row,
): Promise<void> {
	if (!db.options.getBooleanOption('foreign_keys')) return;

	const parentSchemaLower = parentTable.schemaName.toLowerCase();
	const parentTableLower = parentTable.name.toLowerCase();

	for (const schema of db.schemaManager._getAllSchemas()) {
		for (const childTable of schema.getAllTables()) {
			if (!childTable.foreignKeys) continue;

			for (const fk of childTable.foreignKeys) {
				if (fk.referencedTable.toLowerCase() !== parentTableLower) continue;
				const targetSchema = fk.referencedSchema ?? childTable.schemaName;
				if (targetSchema.toLowerCase() !== parentSchemaLower) continue;

				const action = operation === 'delete' ? fk.onDelete : fk.onUpdate;
				if (action !== 'restrict') continue;

				const parentColIndices = resolveReferencedColumns(fk, parentTable);
				if (parentColIndices.length !== fk.columns.length) continue;

				// UPDATE: only enforce when at least one referenced parent column changed.
				if (operation === 'update' && newRow !== undefined) {
					let anyChanged = false;
					for (const idx of parentColIndices) {
						if (!sqlValuesEqual(oldRow[idx] as SqlValue, newRow[idx] as SqlValue)) {
							anyChanged = true;
							break;
						}
					}
					if (!anyChanged) continue;
				}

				// MATCH SIMPLE: NULL parent values cannot be referenced.
				const oldParentValues = parentColIndices.map(idx => oldRow[idx]) as SqlValue[];
				if (oldParentValues.some(v => v === null || v === undefined)) continue;

				const childColNames = fk.columns.map(idx => quoteIdentifier(childTable.columns[idx].name));
				const whereClause = childColNames.map(c => `${c} = ?`).join(' AND ');
				const schemaPrefix = childTable.schemaName.toLowerCase() !== 'main'
					? `${quoteIdentifier(childTable.schemaName)}.`
					: '';
				const sql = `select 1 from ${schemaPrefix}${quoteIdentifier(childTable.name)} where ${whereClause} limit 1`;

				log('RESTRICT check (%s): %s with params %o', operation, sql, oldParentValues);

				const stmt = db.prepare(sql);
				try {
					stmt.bindAll(oldParentValues);
					let referenced = false;
					for await (const _row of stmt._iterateRowsRaw()) {
						referenced = true;
						break;
					}
					if (referenced) {
						const opName = operation === 'delete' ? 'DELETE' : 'UPDATE';
						throw new QuereusError(
							`FOREIGN KEY constraint failed: ${opName} on '${parentTable.name}' violates RESTRICT from '${childTable.name}'`,
							StatusCode.CONSTRAINT,
						);
					}
				} finally {
					await stmt.finalize();
				}
			}
		}
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
	_visited: Set<string>,
): Promise<void> {
	const childColNames = fk.columns.map(idx => childTable.columns[idx].name);
	const whereClause = childColNames
		.map(name => `"${name}" = ?`)
		.join(' AND ');
	const qualifiedChildTable = `"${childTable.schemaName}"."${childTable.name}"`;

	switch (action) {
		case 'cascade': {
			if (newRow === undefined) {
				// CASCADE DELETE: delete matching child rows
				const sql = `DELETE FROM ${qualifiedChildTable} WHERE ${whereClause}`;
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
				const sql = `UPDATE ${qualifiedChildTable} SET ${setClauses} WHERE ${whereParamsClause}`;
				const params = [...newParentValues, ...oldParentValues];
				log('CASCADE UPDATE: %s with params %o', sql, params);
				await db._execWithinTransaction(sql, params);
			}
			break;
		}
		case 'setNull': {
			const setClauses = childColNames.map(name => `"${name}" = NULL`).join(', ');
			const sql = `UPDATE ${qualifiedChildTable} SET ${setClauses} WHERE ${whereClause}`;
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
			const sql = `UPDATE ${qualifiedChildTable} SET ${setClauses} WHERE ${whereClause}`;
			log('SET DEFAULT: %s with params %o', sql, oldParentValues);
			await db._execWithinTransaction(sql, oldParentValues);
			break;
		}
	}
}
