import type { SchemaCatalog } from './catalog.js';
import type * as AST from '../parser/ast.js';
import type { SqlValue } from '../common/types.js';
import { createTableToString, createViewToString, createIndexToString, createAssertionToString, columnDefToString, quoteIdentifier, expressionToString } from '../emit/ast-stringify.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';

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

export interface ColumnAttributeChange {
	columnName: string;
	/** Desired NOT NULL setting. Omitted = no change. */
	notNull?: boolean;
	/** Desired declared (logical) data type. Omitted = no change. */
	dataType?: string;
	/**
	 * Desired DEFAULT expression.
	 *   undefined = no change
	 *   null      = drop existing default
	 *   Expression = set to given expression
	 */
	defaultValue?: AST.Expression | null;
}

export interface TableAlterDiff {
	tableName: string;
	columnsToAdd: string[];
	columnsToDrop: string[];
	columnsToAlter: ColumnAttributeChange[];
	primaryKeyChange?: {
		oldPkColumns: string[];
		newPkColumns: Array<{ name: string; direction?: 'asc' | 'desc' }>;
	};
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
	const declaredAssertions = new Map<string, AST.DeclaredAssertion>();

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
			case 'declaredAssertion':
				declaredAssertions.set(item.assertionStmt.name.toLowerCase(), item);
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
			if (alterDiff.columnsToAdd.length > 0 || alterDiff.columnsToDrop.length > 0 || alterDiff.columnsToAlter.length > 0 || alterDiff.primaryKeyChange) {
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

	// Find assertions to create/drop
	const actualAssertions = new Map(actualCatalog.assertions.map(a => [a.name.toLowerCase(), a]));

	for (const [name, declaredAssertion] of declaredAssertions) {
		if (!actualAssertions.has(name)) {
			diff.assertionsToCreate.push(createAssertionToString(declaredAssertion.assertionStmt));
		}
	}

	for (const [name] of actualAssertions) {
		if (!declaredAssertions.has(name)) {
			diff.assertionsToDrop.push(name);
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
		let parsedArgs: Record<string, SqlValue> = {};
		if (defaultVtabArgs) {
			try {
				parsedArgs = JSON.parse(defaultVtabArgs) as Record<string, SqlValue>;
			} catch (e) {
				throw new QuereusError(
					`Invalid JSON in schema default vtab args for table '${tableStmt.table.name}': ${(e as Error).message}`,
					StatusCode.ERROR,
					e as Error
				);
			}
		}
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
	actualTable: import('./catalog.js').CatalogTable,
): TableAlterDiff {
	const diff: TableAlterDiff = {
		tableName: declaredTable.tableStmt.table.name,
		columnsToAdd: [],
		columnsToDrop: [],
		columnsToAlter: [],
	};

	const declaredColumnsByName = new Map<string, AST.ColumnDef>();
	for (const col of declaredTable.tableStmt.columns) {
		declaredColumnsByName.set(col.name.toLowerCase(), col);
	}
	const actualColumnsByName = new Map<string, import('./catalog.js').CatalogTable['columns'][number]>();
	for (const col of actualTable.columns) {
		actualColumnsByName.set(col.name.toLowerCase(), col);
	}

	// Find columns to add (store full column definition for DDL generation)
	for (const col of declaredTable.tableStmt.columns) {
		if (!actualColumnsByName.has(col.name.toLowerCase())) {
			diff.columnsToAdd.push(columnDefToString(col));
		}
	}

	// Find columns to drop
	for (const col of actualTable.columns) {
		if (!declaredColumnsByName.has(col.name.toLowerCase())) {
			diff.columnsToDrop.push(col.name);
		}
	}

	// Detect attribute changes for surviving columns (present in both declared + actual)
	for (const col of declaredTable.tableStmt.columns) {
		const actual = actualColumnsByName.get(col.name.toLowerCase());
		if (!actual) continue;
		const change = computeColumnAttributeChange(col, actual);
		if (change) {
			diff.columnsToAlter.push(change);
		}
	}

	// Detect PK changes
	const declaredPk = extractDeclaredPK(declaredTable);
	const actualPk = actualTable.primaryKey;

	if (!pkSequencesEqual(declaredPk, actualPk)) {
		diff.primaryKeyChange = {
			oldPkColumns: actualPk.map(pk => pk.columnName),
			newPkColumns: declaredPk,
		};
	}

	return diff;
}

/**
 * Extract a declared column's effective nullability from its AST constraints.
 * Returns undefined when no explicit NULL/NOT NULL is present (session default applies).
 */
function extractDeclaredNotNull(col: AST.ColumnDef): boolean | undefined {
	if (!col.constraints) return undefined;
	// PK always implies NOT NULL.
	if (col.constraints.some(c => c.type === 'primaryKey')) return true;
	for (const c of col.constraints) {
		if (c.type === 'notNull') return true;
		if (c.type === 'null') return false;
	}
	return undefined;
}

function extractDeclaredDefault(col: AST.ColumnDef): AST.Expression | null {
	if (!col.constraints) return null;
	const d = col.constraints.find(c => c.type === 'default');
	return d?.expr ?? null;
}

/**
 * Structural equality for DEFAULT expressions. Compares AST shape by
 * JSON serialization with a stable key order — adequate for literals
 * and common expression shapes typically used as DEFAULT values.
 */
function defaultExpressionsEqual(a: AST.Expression | null, b: AST.Expression | null): boolean {
	if (a === null && b === null) return true;
	if (a === null || b === null) return false;
	return stableStringify(a) === stableStringify(b);
}

function stableStringify(v: unknown): string {
	if (v === null || typeof v !== 'object') return JSON.stringify(v);
	if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
	const obj = v as Record<string, unknown>;
	const keys = Object.keys(obj).filter(k => k !== 'loc').sort();
	return `{${keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',')}}`;
}

function computeColumnAttributeChange(
	declared: AST.ColumnDef,
	actual: import('./catalog.js').CatalogTable['columns'][number],
): ColumnAttributeChange | undefined {
	const change: ColumnAttributeChange = { columnName: declared.name };
	let any = false;

	// Nullability — only compare when explicitly declared; session default handles unspecified.
	const declaredNotNull = extractDeclaredNotNull(declared);
	if (declaredNotNull !== undefined && declaredNotNull !== actual.notNull) {
		change.notNull = declaredNotNull;
		any = true;
	}

	// Data type — declared type is a string; compare case-insensitively.
	if (declared.dataType && declared.dataType.toLowerCase() !== actual.type.toLowerCase()) {
		change.dataType = declared.dataType;
		any = true;
	}

	// Default expression — declared absent + actual present → drop (null).
	const declaredDefault = extractDeclaredDefault(declared);
	const hasDeclaredDefaultConstraint = !!declared.constraints?.some(c => c.type === 'default');
	const actualDefault = actual.defaultValue ?? null;
	if (hasDeclaredDefaultConstraint) {
		if (!defaultExpressionsEqual(declaredDefault, actualDefault)) {
			change.defaultValue = declaredDefault;
			any = true;
		}
	} else if (actualDefault !== null) {
		change.defaultValue = null;
		any = true;
	}

	return any ? change : undefined;
}

function extractDeclaredPK(declaredTable: AST.DeclaredTable): Array<{ name: string; direction?: 'asc' | 'desc' }> {
	const stmt = declaredTable.tableStmt;

	// Check for table-level PRIMARY KEY constraint
	if (stmt.constraints) {
		for (const constraint of stmt.constraints) {
			if (constraint.type === 'primaryKey' && constraint.columns) {
				return constraint.columns.map(c => ({
					name: c.name,
					direction: c.direction,
				}));
			}
		}
	}

	// Check for column-level PRIMARY KEY
	const pkCols: Array<{ name: string; direction?: 'asc' | 'desc' }> = [];
	for (const col of stmt.columns) {
		if (col.constraints?.some(c => c.type === 'primaryKey')) {
			const pkConstraint = col.constraints.find(c => c.type === 'primaryKey');
			pkCols.push({
				name: col.name,
				direction: pkConstraint?.type === 'primaryKey' ? pkConstraint.direction : undefined,
			});
		}
	}

	if (pkCols.length > 0) return pkCols;

	// No explicit PK — Quereus defaults to all columns
	return stmt.columns.map(c => ({ name: c.name }));
}

function pkSequencesEqual(
	declared: Array<{ name: string; direction?: 'asc' | 'desc' }>,
	actual: Array<{ columnName: string; desc: boolean }>,
): boolean {
	if (declared.length !== actual.length) return false;
	for (let i = 0; i < declared.length; i++) {
		if (declared[i].name.toLowerCase() !== actual[i].columnName.toLowerCase()) return false;
		const declaredDesc = declared[i].direction === 'desc';
		if (declaredDesc !== actual[i].desc) return false;
	}
	return true;
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
	const schemaPrefix = (schemaName && schemaName !== 'main') ? `${quoteIdentifier(schemaName)}.` : '';

	// Drop assertions first (they may reference tables)
	for (const name of diff.assertionsToDrop) {
		statements.push(`DROP ASSERTION IF EXISTS ${schemaPrefix}${quoteIdentifier(name)}`);
	}

	// Drop items (reverse order)
	for (const tableName of diff.tablesToDrop) {
		statements.push(`DROP TABLE IF EXISTS ${schemaPrefix}${quoteIdentifier(tableName)}`);
	}

	for (const viewName of diff.viewsToDrop) {
		statements.push(`DROP VIEW IF EXISTS ${schemaPrefix}${quoteIdentifier(viewName)}`);
	}

	for (const indexName of diff.indexesToDrop) {
		statements.push(`DROP INDEX IF EXISTS ${schemaPrefix}${quoteIdentifier(indexName)}`);
	}

	// Create new items
	statements.push(...diff.tablesToCreate);
	statements.push(...diff.viewsToCreate);
	statements.push(...diff.indexesToCreate);
	statements.push(...diff.assertionsToCreate);

	// Alter existing tables.
	// Phase order within one table:
	//   ADD COLUMN
	//   → ALTER COLUMN (type, then default, then nullability — so SET NOT NULL
	//     can rely on an already-populated DEFAULT for backfill)
	//   → ALTER PRIMARY KEY
	//   → DROP COLUMN (last, so NOT NULL relaxation never blocks subsequent drops)
	for (const alter of diff.tablesToAlter) {
		const quotedTable = `${schemaPrefix}${quoteIdentifier(alter.tableName)}`;
		for (const colDef of alter.columnsToAdd) {
			statements.push(`ALTER TABLE ${quotedTable} ADD COLUMN ${colDef}`);
		}
		for (const colAlter of alter.columnsToAlter) {
			const quotedCol = quoteIdentifier(colAlter.columnName);
			if (colAlter.dataType !== undefined) {
				statements.push(`ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedCol} SET DATA TYPE ${colAlter.dataType}`);
			}
			if (colAlter.defaultValue !== undefined) {
				if (colAlter.defaultValue === null) {
					statements.push(`ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedCol} DROP DEFAULT`);
				} else {
					statements.push(`ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedCol} SET DEFAULT ${expressionToString(colAlter.defaultValue)}`);
				}
			}
			if (colAlter.notNull !== undefined) {
				statements.push(colAlter.notNull
					? `ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedCol} SET NOT NULL`
					: `ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedCol} DROP NOT NULL`);
			}
		}
		if (alter.primaryKeyChange) {
			const pkCols = alter.primaryKeyChange.newPkColumns
				.map(c => {
					let s = quoteIdentifier(c.name);
					if (c.direction === 'desc') s += ' desc';
					return s;
				})
				.join(', ');
			statements.push(`ALTER TABLE ${quotedTable} ALTER PRIMARY KEY (${pkCols})`);
		}
		for (const colName of alter.columnsToDrop) {
			statements.push(`ALTER TABLE ${quotedTable} DROP COLUMN ${quoteIdentifier(colName)}`);
		}
	}

	return statements;
}


