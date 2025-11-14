import type { Database } from '../core/database.js';
import type { TableSchema, IndexSchema } from './table.js';
import type { ViewSchema } from './view.js';
import type { IntegrityAssertionSchema } from './assertion.js';
import { createTableToString, createViewToString, createIndexToString } from '../util/ast-stringify.js';
import type * as AST from '../parser/ast.js';

/**
 * Represents a catalog snapshot of the current database schema state
 */
export interface SchemaCatalog {
	schemaName: string;
	tables: CatalogTable[];
	views: CatalogView[];
	indexes: CatalogIndex[];
	assertions: CatalogAssertion[];
}

export interface CatalogTable {
	name: string;
	ddl: string;
	columns: Array<{ name: string; type: string; notNull: boolean; primaryKey: boolean }>;
}

export interface CatalogView {
	name: string;
	ddl: string;
}

export interface CatalogIndex {
	name: string;
	tableName: string;
	ddl: string;
}

export interface CatalogAssertion {
	name: string;
	ddl: string;
}

/**
 * Collects current schema state from the database into a catalog representation
 */
export function collectSchemaCatalog(db: Database, schemaName: string = 'main'): SchemaCatalog {
	const schema = db.schemaManager.getSchema(schemaName);
	if (!schema) {
		return {
			schemaName,
			tables: [],
			views: [],
			indexes: [],
			assertions: []
		};
	}

	const tables: CatalogTable[] = [];
	const views: CatalogView[] = [];
	const indexes: CatalogIndex[] = [];
	const assertions: CatalogAssertion[] = [];

	// Collect tables
	for (const tableSchema of schema.getAllTables()) {
		if (!tableSchema.isView) {
			tables.push(tableSchemaToCatalog(tableSchema));

			// Collect indexes for this table
			if (tableSchema.indexes && tableSchema.indexes.length > 0) {
				for (const indexSchema of tableSchema.indexes) {
					indexes.push({
						name: indexSchema.name,
						tableName: tableSchema.name,
						ddl: generateIndexDDL(indexSchema, tableSchema)
					});
				}
			}
		}
	}

	// Collect views
	for (const viewSchema of schema.getAllViews()) {
		views.push(viewSchemaToCatalog(viewSchema));
	}

	// Collect assertions
	for (const assertionSchema of schema.getAllAssertions()) {
		assertions.push(assertionSchemaToCatalog(assertionSchema));
	}

	return {
		schemaName,
		tables,
		views,
		indexes,
		assertions
	};
}

function tableSchemaToCatalog(tableSchema: TableSchema): CatalogTable {
	// Generate canonical DDL from TableSchema
	const ddl = generateTableDDL(tableSchema);

	const columns = tableSchema.columns.map(col => ({
		name: col.name,
		type: col.logicalType.name,
		notNull: col.notNull,
		primaryKey: col.primaryKey
	}));

	return {
		name: tableSchema.name,
		ddl,
		columns
	};
}

function viewSchemaToCatalog(viewSchema: ViewSchema): CatalogView {
	return {
		name: viewSchema.name,
		ddl: viewSchema.sql
	};
}

function assertionSchemaToCatalog(assertionSchema: IntegrityAssertionSchema): CatalogAssertion {
	return {
		name: assertionSchema.name,
		ddl: `CREATE ASSERTION ${assertionSchema.name} CHECK (${assertionSchema.violationSql})`
	};
}

/**
 * Generates canonical DDL for an index from its schema
 */
function generateIndexDDL(indexSchema: IndexSchema, tableSchema: TableSchema): string {
	// Convert IndexSchema back to AST CreateIndexStmt for stringification
	const indexStmt: AST.CreateIndexStmt = {
		type: 'createIndex',
		index: { type: 'identifier', name: indexSchema.name },
		table: { type: 'identifier', name: tableSchema.name },
		ifNotExists: false,
		isUnique: false,
		columns: indexSchema.columns.map(col => ({
			name: tableSchema.columns[col.index].name,
			expr: undefined,
			collation: col.collation,
			direction: col.desc ? 'desc' : 'asc'
		}))
	};

	return createIndexToString(indexStmt);
}

/**
 * Generates canonical DDL for a table from its schema
 */
function generateTableDDL(tableSchema: TableSchema): string {
	const parts: string[] = ['CREATE TABLE'];

	if (tableSchema.isTemporary) {
		parts.push('TEMP');
	}

	parts.push(`"${tableSchema.name}"`);

	// Generate column definitions
	const columnDefs: string[] = [];
	for (const col of tableSchema.columns) {
		let colDef = `"${col.name}"`;
		if (col.logicalType) {
			colDef += ` ${col.logicalType.name}`;
		}
		if (col.notNull) {
			colDef += ' NOT NULL';
		}
		if (col.primaryKey && tableSchema.primaryKeyDefinition.length === 1) {
			colDef += ' PRIMARY KEY';
		}
		columnDefs.push(colDef);
	}

	// Add table-level PRIMARY KEY if composite
	if (tableSchema.primaryKeyDefinition.length > 1) {
		const pkCols = tableSchema.primaryKeyDefinition
			.map(pk => `"${tableSchema.columns[pk.index].name}"`)
			.join(', ');
		columnDefs.push(`PRIMARY KEY (${pkCols})`);
	}

	parts.push(`(${columnDefs.join(', ')})`);

	// Add USING clause
	if (tableSchema.vtabModuleName) {
		parts.push(`USING ${tableSchema.vtabModuleName}`);
		if (tableSchema.vtabArgs && Object.keys(tableSchema.vtabArgs).length > 0) {
			const args = Object.entries(tableSchema.vtabArgs)
				.map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
				.join(', ');
			parts.push(`(${args})`);
		}
	}

	return parts.join(' ');
}

/**
 * Generates canonical DDL from a declared schema AST
 */
export function generateDeclaredDDL(declaredSchema: AST.DeclareSchemaStmt, targetSchema?: string): string[] {
	const ddlStatements: string[] = [];

	for (const item of declaredSchema.items) {
		switch (item.type) {
			case 'declaredTable': {
				// Qualify table name with schema if specified
				const tableStmt = item.tableStmt;
				if (targetSchema && targetSchema !== 'main' && !tableStmt.table.schema) {
					const qualifiedStmt: AST.CreateTableStmt = {
						...tableStmt,
						table: {
							...tableStmt.table,
							schema: targetSchema
						}
					};
					ddlStatements.push(createTableToString(qualifiedStmt));
				} else {
					ddlStatements.push(createTableToString(tableStmt));
				}
				break;
			}
			case 'declaredIndex': {
				// Generate index DDL using AST stringifier
				const indexStmt = item.indexStmt;
				if (targetSchema && targetSchema !== 'main' && !indexStmt.table.schema) {
					const qualifiedStmt: AST.CreateIndexStmt = {
						...indexStmt,
						table: {
							...indexStmt.table,
							schema: targetSchema
						}
					};
					ddlStatements.push(createIndexToString(qualifiedStmt));
				} else {
					ddlStatements.push(createIndexToString(indexStmt));
				}
				break;
			}
			case 'declaredView': {
				// Qualify view name with schema if specified
				const viewStmt = item.viewStmt;
				if (targetSchema && targetSchema !== 'main' && !viewStmt.view.schema) {
					const qualifiedStmt: AST.CreateViewStmt = {
						...viewStmt,
						view: {
							...viewStmt.view,
							schema: targetSchema
						}
					};
					ddlStatements.push(createViewToString(qualifiedStmt));
				} else {
					ddlStatements.push(createViewToString(viewStmt));
				}
				break;
			}
		}
	}

	return ddlStatements;
}


