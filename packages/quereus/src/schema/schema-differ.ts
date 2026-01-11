import type { SchemaCatalog } from './catalog.js';
import type * as AST from '../parser/ast.js';
import type { SqlValue } from '../common/types.js';
import { createTableToString, createViewToString, createIndexToString } from '../emit/ast-stringify.js';

/**
 * Represents the difference between a declared schema and actual database state
 */
export interface SchemaDiff {
	tablesToCreate: string[];
	tablesToDrop: string[];
	tablesToAlter: TableAlterDiff[];
	viewsToCreate: string[];
	viewsToDrop: string[];
	indexesToCreate: string[];
	indexesToDrop: string[];
	assertionsToCreate: string[];
	assertionsToDrop: string[];
}

export interface TableAlterDiff {
	tableName: string;
	columnsToAdd: string[];
	columnsToDrop: string[];
}

/**
 * Computes the difference between declared schema and actual catalog
 */
export function computeSchemaDiff(
	declaredSchema: AST.DeclareSchemaStmt,
	actualCatalog: SchemaCatalog
): SchemaDiff {
	const diff: SchemaDiff = {
		tablesToCreate: [],
		tablesToDrop: [],
		tablesToAlter: [],
		viewsToCreate: [],
		viewsToDrop: [],
		indexesToCreate: [],
		indexesToDrop: [],
		assertionsToCreate: [],
		assertionsToDrop: []
	};

	const targetSchemaName = actualCatalog.schemaName;

	// Extract schema-level default module settings
	const defaultVtabModule = declaredSchema.using?.defaultVtabModule;
	const defaultVtabArgs = declaredSchema.using?.defaultVtabArgs;

	// Build maps of declared items
	const declaredTables = new Map<string, AST.DeclaredTable>();
	const declaredViews = new Map<string, AST.DeclaredView>();
	const declaredIndexes = new Map<string, AST.DeclaredIndex>();

	for (const item of declaredSchema.items) {
		switch (item.type) {
			case 'declaredTable':
				declaredTables.set(item.tableStmt.table.name.toLowerCase(), item);
				break;
			case 'declaredView':
				declaredViews.set(item.viewStmt.view.name.toLowerCase(), item);
				break;
			case 'declaredIndex':
				declaredIndexes.set(item.indexStmt.index.name.toLowerCase(), item);
				break;
		}
	}

	// Build maps of actual items
	const actualTables = new Map(actualCatalog.tables.map(t => [t.name.toLowerCase(), t]));
	const actualViews = new Map(actualCatalog.views.map(v => [v.name.toLowerCase(), v]));
	const actualIndexes = new Map(actualCatalog.indexes.map(i => [i.name.toLowerCase(), i]));

	// Find tables to create (in declared but not in actual)
	for (const [name, declaredTable] of declaredTables) {
		if (!actualTables.has(name)) {
			// Build the effective table statement, applying schema-level defaults
			const tableStmt = declaredTable.tableStmt;
			const effectiveStmt = applyTableDefaults(tableStmt, targetSchemaName, defaultVtabModule, defaultVtabArgs);
			diff.tablesToCreate.push(createTableToString(effectiveStmt));
		} else {
			// Table exists - check if it needs alteration
			const alterDiff = computeTableAlterDiff(declaredTable, actualTables.get(name)!);
			if (alterDiff.columnsToAdd.length > 0 || alterDiff.columnsToDrop.length > 0) {
				diff.tablesToAlter.push(alterDiff);
			}
		}
	}

	// Find tables to drop (in actual but not in declared)
	for (const [name] of actualTables) {
		if (!declaredTables.has(name)) {
			diff.tablesToDrop.push(name);
		}
	}

	// Find views to create/drop
	for (const [name, declaredView] of declaredViews) {
		if (!actualViews.has(name)) {
			// Generate proper view DDL using AST stringifier
			diff.viewsToCreate.push(createViewToString(declaredView.viewStmt));
		}
	}

	for (const [name] of actualViews) {
		if (!declaredViews.has(name)) {
			diff.viewsToDrop.push(name);
		}
	}

	// Find indexes to create/drop
	for (const [name, declaredIndex] of declaredIndexes) {
		if (!actualIndexes.has(name)) {
			// Apply schema name to the index and its table reference
			const effectiveStmt = applyIndexDefaults(declaredIndex.indexStmt, targetSchemaName);
			diff.indexesToCreate.push(createIndexToString(effectiveStmt));
		}
	}

	for (const [name] of actualIndexes) {
		if (!declaredIndexes.has(name)) {
			diff.indexesToDrop.push(name);
		}
	}

	return diff;
}

/**
 * Applies schema-level defaults (schema name, default vtab module) to a table statement
 */
function applyTableDefaults(
	tableStmt: AST.CreateTableStmt,
	targetSchemaName: string,
	defaultVtabModule?: string,
	defaultVtabArgs?: string
): AST.CreateTableStmt {
	let result = tableStmt;

	// Apply schema name if not main and not already specified
	if (targetSchemaName && targetSchemaName !== 'main' && !tableStmt.table.schema) {
		result = {
			...result,
			table: {
				...result.table,
				schema: targetSchemaName
			}
		};
	}

	// Apply default vtab module if table doesn't have an explicit one
	if (!tableStmt.moduleName && defaultVtabModule) {
		const parsedArgs: Record<string, SqlValue> = defaultVtabArgs
			? JSON.parse(defaultVtabArgs) as Record<string, SqlValue>
			: {};
		result = {
			...result,
			moduleName: defaultVtabModule,
			moduleArgs: parsedArgs
		};
	}

	return result;
}

/**
 * Applies schema name to an index statement and its table reference
 */
function applyIndexDefaults(
	indexStmt: AST.CreateIndexStmt,
	targetSchemaName: string
): AST.CreateIndexStmt {
	let result = indexStmt;

	// Apply schema name to the index if not main and not already specified
	if (targetSchemaName && targetSchemaName !== 'main') {
		// Apply schema to the index name
		if (!indexStmt.index.schema) {
			result = {
				...result,
				index: {
					...result.index,
					schema: targetSchemaName
				}
			};
		}
		// Apply schema to the table reference
		if (!indexStmt.table.schema) {
			result = {
				...result,
				table: {
					...result.table,
					schema: targetSchemaName
				}
			};
		}
	}

	return result;
}

function computeTableAlterDiff(
	declaredTable: AST.DeclaredTable,
	actualTable: { name: string; columns: Array<{ name: string }> }
): TableAlterDiff {
	const diff: TableAlterDiff = {
		tableName: declaredTable.tableStmt.table.name,
		columnsToAdd: [],
		columnsToDrop: []
	};

	const declaredColumns = new Set(
		declaredTable.tableStmt.columns.map(c => c.name.toLowerCase())
	);
	const actualColumns = new Set(
		actualTable.columns.map(c => c.name.toLowerCase())
	);

	// Find columns to add
	for (const col of declaredTable.tableStmt.columns) {
		if (!actualColumns.has(col.name.toLowerCase())) {
			diff.columnsToAdd.push(col.name);
		}
	}

	// Find columns to drop
	for (const col of actualTable.columns) {
		if (!declaredColumns.has(col.name.toLowerCase())) {
			diff.columnsToDrop.push(col.name);
		}
	}

	return diff;
}

/**
 * Serializes a schema diff to JSON string
 */
export function serializeSchemaDiff(diff: SchemaDiff): string {
	return JSON.stringify(diff, null, 2);
}

/**
 * Generates migration DDL statements from a schema diff
 */
export function generateMigrationDDL(diff: SchemaDiff, schemaName?: string): string[] {
	const statements: string[] = [];
	const schemaPrefix = (schemaName && schemaName !== 'main') ? `${schemaName}.` : '';

	// Drop items first (reverse order)
	for (const tableName of diff.tablesToDrop) {
		statements.push(`DROP TABLE IF EXISTS ${schemaPrefix}${tableName}`);
	}

	for (const viewName of diff.viewsToDrop) {
		statements.push(`DROP VIEW IF EXISTS ${schemaPrefix}${viewName}`);
	}

	for (const indexName of diff.indexesToDrop) {
		statements.push(`DROP INDEX IF EXISTS ${schemaPrefix}${indexName}`);
	}

	// Create new items
	statements.push(...diff.tablesToCreate);
	statements.push(...diff.viewsToCreate);
	statements.push(...diff.indexesToCreate);

	// Alter existing tables
	for (const alter of diff.tablesToAlter) {
		for (const colName of alter.columnsToAdd) {
			statements.push(`ALTER TABLE ${schemaPrefix}${alter.tableName} ADD COLUMN ${colName}`);
		}
		for (const colName of alter.columnsToDrop) {
			statements.push(`ALTER TABLE ${schemaPrefix}${alter.tableName} DROP COLUMN ${colName}`);
		}
	}

	return statements;
}


