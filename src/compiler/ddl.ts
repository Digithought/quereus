import type { Compiler } from "./compiler.js";
import type * as AST from "../parser/ast.js";
import { StatusCode, SqlDataType } from "../common/constants.js";
import { SqliteError } from "../common/errors.js";
import { Opcode } from '../vdbe/opcodes.js';
import type { VirtualTable } from "../vtab/table.js";
import type { ViewSchema } from '../schema/view.js';
import type { Schema } from '../schema/schema.js';
import { Parser } from "../parser/parser.js";
import type { SqlValue } from "../common/types.js";
import type { BaseModuleConfig } from '../vtab/module.js';
import type { Expression } from '../parser/ast.js';
import type { P4SchemaChange } from "../vdbe/instruction.js";
import { opsToMask, type IndexSchema, type RowOpMask, type TableSchema } from "../schema/table.js";
import type { ColumnSchema } from "../schema/column.js";
import { createLogger } from '../common/logger.js';

const log = createLogger('compiler:ddl');
const warnLog = log.extend('warn');

// Define local interfaces if not exported/importable easily
interface MemoryTableConfig extends BaseModuleConfig {
	columns: { name: string, type: string, collation?: string }[];
	primaryKey?: ReadonlyArray<{ index: number; desc: boolean }>;
	checkConstraints?: ReadonlyArray<{ name?: string, expr: Expression, operations: RowOpMask }>;
	readOnly?: boolean;
}
interface JsonConfig extends BaseModuleConfig {
	jsonSource: SqlValue;
	rootPath?: SqlValue;
}

export function compileCreateTableStatement(compiler: Compiler, stmt: AST.CreateTableStmt): void {
	const db = compiler.db;
	const schemaName = stmt.table.schema || 'main';
	const tableName = stmt.table.name;
	let moduleName: string;
	let moduleArgs: string[] = [];
	let usingExplicitModule = false;
	// let explicitMemoryModule = false; // Not needed with current logic

	// Determine module and args source
	if (stmt.moduleName) {
		moduleName = stmt.moduleName;
		moduleArgs = stmt.moduleArgs || [];
		usingExplicitModule = true;
		// explicitMemoryModule = moduleName.toLowerCase() === 'memory';
	} else {
		const defaultVtab = db.getDefaultVtabModule();
		moduleName = defaultVtab.name;
		// Default args are prepended IF specific module args aren't given via USING
		moduleArgs = [...defaultVtab.args];
	}

	const moduleInfo = db._getVtabModule(moduleName);
	if (!moduleInfo) {
		throw new SqliteError(`No virtual table module named '${moduleName}'`, StatusCode.ERROR, undefined, stmt.loc?.start.line, stmt.loc?.start.column);
	}

	// --- Construct Module Options (TConfig) ---
	let options: BaseModuleConfig;

	try {
		if (moduleName.toLowerCase() === 'memory') {
			let columns: { name: string, type: string, collation?: string }[];
			let primaryKey: ReadonlyArray<{ index: number; desc: boolean }> | undefined;
			let checkConstraints: { name?: string, expr: Expression, operations: RowOpMask }[] = [];

			if (usingExplicitModule) {
				// Case: CREATE TABLE ... USING memory('CREATE TABLE ...');
				if (moduleArgs.length === 0 || !moduleArgs[0].trim().toUpperCase().startsWith('CREATE TABLE')) {
					throw new Error("When using 'USING memory(...)', the first argument must be the CREATE TABLE DDL string.");
				}
				const ddlString = moduleArgs[0];
				const parser = new Parser();
				const parsedAst = parser.parse(ddlString);
				if (parsedAst.type !== 'createTable') {
					throw new Error("Argument provided to 'USING memory(...)' did not parse as a CREATE TABLE statement.");
				}
				const createTableAst = parsedAst as AST.CreateTableStmt;
				// Pass the original data type string, default to 'BLOB' if undefined
				columns = createTableAst.columns.map(c => ({ name: c.name, type: c.dataType ?? 'BLOB' }));
				primaryKey = parsePrimaryKeyFromAst(createTableAst.columns, createTableAst.constraints);
				// Gather checks from parsed DDL AST
				createTableAst.columns.forEach(colDef => {
					colDef.constraints?.forEach(con => {
						if (con.type === 'check' && con.expr) {
							checkConstraints.push({ name: con.name, expr: con.expr, operations: opsToMask(con.operations) });
						}
					});
				});
				createTableAst.constraints?.forEach(con => {
					if (con.type === 'check' && con.expr) {
						checkConstraints.push({ name: con.name, expr: con.expr, operations: opsToMask(con.operations) });
					}
				});
				// TODO: Parse readOnly from subsequent args if desired? e.g., USING memory(ddl, 'readOnly=true')
			} else {
				// Case: CREATE TABLE ... ; (Implicitly uses default memory module)
				// Use columns/constraints directly from the main statement's AST
				if (!stmt.columns || stmt.columns.length === 0) {
					throw new Error("Cannot create implicit memory table without column definitions.");
				}
				// Pass the original data type string, default to 'BLOB' if undefined
				columns = stmt.columns.map(c => ({ name: c.name, type: c.dataType ?? 'BLOB' }));
				primaryKey = parsePrimaryKeyFromAst(stmt.columns, stmt.constraints || []);
				// Gather checks from main statement AST
				stmt.columns.forEach(colDef => {
					colDef.constraints?.forEach(con => {
						if (con.type === 'check' && con.expr) {
							checkConstraints.push({ name: con.name, expr: con.expr, operations: opsToMask(con.operations) });
						}
					});
				});
				stmt.constraints?.forEach(con => {
					if (con.type === 'check' && con.expr) {
						checkConstraints.push({ name: con.name, expr: con.expr, operations: opsToMask(con.operations) });
					}
				});
			}

			options = {
				columns: Object.freeze(columns),
				primaryKey: primaryKey,
				checkConstraints: Object.freeze(checkConstraints),
				readOnly: false // Default readOnly, could be configurable later
			} as MemoryTableConfig;

		} else if (moduleName.toLowerCase() === 'json_each' || moduleName.toLowerCase() === 'json_tree') {
			// Expects 1 or 2 args: jsonSource, [rootPath]
			if (moduleArgs.length < 1 || moduleArgs.length > 2) {
				throw new Error(`${moduleName} requires 1 or 2 arguments (jsonSource, [rootPath])`);
			}
			options = {
				jsonSource: moduleArgs[0], // Assume string args are handled correctly later
				rootPath: moduleArgs[1]
			} as JsonConfig;
		} else {
			// Generic module - pass empty config for now
			// The module's xCreate needs to handle this or expect specific arg parsing
			warnLog(`Compiler creating generic BaseModuleConfig for module '%s'. Module may need specific arg parsing.`, moduleName);
			options = {}; // Empty BaseModuleConfig
		}
	} catch (e: any) {
		throw new SqliteError(`Failed to parse arguments for module '${moduleName}': ${e.message}`, StatusCode.ERROR, e instanceof Error ? e : undefined, stmt.loc?.start.line, stmt.loc?.start.column);
	}
	// --- End Construct Module Options ---

	let tableInstance: VirtualTable;
	try {
		// Call xCreate with the new signature
		tableInstance = moduleInfo.module.xCreate(
			db,
			moduleInfo.auxData,
			moduleName, // Pass explicit moduleName
			schemaName, // Pass explicit schemaName
			tableName,  // Pass explicit tableName
			options     // Pass constructed options object
		);
	} catch (e: any) {
		const message = e instanceof Error ? e.message : String(e);
		const code = e instanceof SqliteError ? e.code : StatusCode.ERROR;
		throw new SqliteError(`Module '${moduleName}' xCreate failed for table '${tableName}': ${message}`, code, e instanceof Error ? e : undefined, stmt.loc?.start.line, stmt.loc?.start.column);
	}

	const schema = db.schemaManager.getSchema(schemaName);
	if (!schema) {
		throw new SqliteError(`Internal error: Schema '${schemaName}' not found during CREATE TABLE.`, StatusCode.INTERNAL);
	}

	if (schema.getTable(tableName)) {
		if (stmt.ifNotExists) {
			log(`Skipping CREATE TABLE: Table %s.%s already exists (IF NOT EXISTS).`, schemaName, tableName);
			compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, `CREATE TABLE ${tableName} (skipped IF NOT EXISTS)`);
			return;
		} else {
			throw new SqliteError(`Table ${schemaName}.${tableName} already exists`, StatusCode.ERROR, undefined, stmt.table.loc?.start.line, stmt.table.loc?.start.column);
		}
	}

	if (!tableInstance.tableSchema) {
		throw new SqliteError(`Module '${moduleName}' xCreate did not provide a tableSchema for '${tableName}'.`, StatusCode.INTERNAL);
	}
	if (tableInstance.tableSchema.schemaName.toLowerCase() !== schemaName.toLowerCase()) {
		warnLog(`VTab module %s created table %s in schema %s, but expected %s.`, moduleName, tableName, tableInstance.tableSchema.schemaName, schemaName);
		(tableInstance.tableSchema as any).schemaName = schemaName;
	}
	if (!tableInstance.tableSchema.vtabModuleName) {
		(tableInstance.tableSchema as any).vtabModuleName = moduleName;
	}
	if (!tableInstance.tableSchema.vtabArgs) {
		(tableInstance.tableSchema as any).vtabArgs = Object.freeze(moduleArgs);
	}

	// Assign default estimated rows if not provided by the module
	if (tableInstance.tableSchema.estimatedRows === undefined) {
		// Use a large default value to indicate unknown/large size
		(tableInstance.tableSchema as any).estimatedRows = BigInt(10_000);
	}

	schema.addTable(tableInstance.tableSchema);

	log(`Successfully created table %s.%s using module %s`, schemaName, tableName, moduleName);
	compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, `CREATE TABLE ${tableName}`);
}

export function compileCreateIndexStatement(compiler: Compiler, stmt: AST.CreateIndexStmt): void {
	const db = compiler.db;
	const schemaName = stmt.table.schema || 'main';
	const tableName = stmt.table.name;
	const indexName = stmt.index.name;

	// Find the table schema
	const tableSchema = db.schemaManager.getTable(schemaName, tableName);
	if (!tableSchema) {
		throw new SqliteError(`no such table: ${tableName}`, StatusCode.ERROR, undefined, stmt.table.loc?.start.line, stmt.table.loc?.start.column);
	}

	// Check if the virtual table prototype supports xCreateIndex
	if (typeof (tableSchema.vtabModule as any)?.xCreateIndex !== 'function') {
		throw new SqliteError(`Virtual table module '${tableSchema.vtabModuleName}' for table '${tableName}' does not support CREATE INDEX.`, StatusCode.ERROR, undefined, stmt.table.loc?.start.line, stmt.table.loc?.start.column);
	}

	// Convert AST columns to IndexSchema columns
	const indexColumns = stmt.columns.map((indexedCol: AST.IndexedColumn) => {
		if (indexedCol.expr) {
			throw new SqliteError(`Indices on expressions are not supported yet.`, StatusCode.ERROR, undefined, indexedCol.expr.loc?.start.line, indexedCol.expr.loc?.start.column);
		}
		const colName = indexedCol.name;
		if (!colName) {
			// Should not happen if expr is checked first
			throw new SqliteError(`Indexed column must be a simple column name.`, StatusCode.ERROR);
		}
		const tableColIndex = tableSchema.columnIndexMap.get(colName.toLowerCase());
		if (tableColIndex === undefined) {
			throw new SqliteError(`Column '${colName}' not found in table '${tableName}'`, StatusCode.ERROR, undefined, stmt.loc?.start.line, stmt.loc?.start.column);
		}
		const tableColSchema = tableSchema.columns[tableColIndex];
		return {
			index: tableColIndex,
			desc: indexedCol.direction === 'desc',
			collation: tableColSchema.collation // Inherit collation from table column for now
		};
	});

	// Construct the IndexSchema object
	const indexSchema: IndexSchema = {
		name: indexName,
		columns: Object.freeze(indexColumns),
		// unique: stmt.isUnique, // Add if needed
		// where: stmt.where ? stringifyExpr(stmt.where) : undefined, // Add if needed
	};

	// Allocate a cursor for the target table
	let cursorIdx = -1;
	for (const [idx, schema] of compiler.tableSchemas.entries()) {
		if (schema === tableSchema) {
			cursorIdx = idx;
			break;
		}
	}
	if (cursorIdx === -1) {
		cursorIdx = compiler.allocateCursor();
		compiler.tableSchemas.set(cursorIdx, tableSchema);
		// Use OpenWrite as CREATE INDEX modifies the VTab state
		compiler.emit(Opcode.OpenWrite, cursorIdx, 0, 0, tableSchema, 0, `Open VTab ${tableName} for CREATE INDEX`);
	} else {
		// Re-open if already open (might be needed if used earlier in a multi-stmt script)
		compiler.emit(Opcode.OpenWrite, cursorIdx, 0, 0, tableSchema, 0, `Re-Open VTab ${tableName} for CREATE INDEX`);
	}

	// Emit the VCreateIndex opcode
	compiler.emit(Opcode.VCreateIndex, cursorIdx, 0, 0, indexSchema, 0, `CREATE INDEX ${indexName} ON ${tableName}`);

	// Close the cursor
	compiler.emit(Opcode.Close, cursorIdx, 0, 0, null, 0, `Close VTab cursor after CREATE INDEX`);

	// Invalidate schema cache as structure changed
	compiler.emit(Opcode.SchemaInvalidate, 0, 0, 0, null, 0, `Invalidate schema after CREATE INDEX`);
}

export function compileCreateViewStatement(compiler: Compiler, stmt: AST.CreateViewStmt): void {
	const schemaName = stmt.view.schema ?? compiler.db.schemaManager.getCurrentSchemaName();
	const viewName = stmt.view.name;

	// Get target schema
	let schema: Schema;
	try {
		schema = compiler.db.schemaManager.getSchemaOrFail(schemaName);
	} catch (e) {
		const foundSchema = compiler.db.schemaManager.getSchema(schemaName);
		if (!foundSchema) {
			throw new SqliteError(`Schema '${schemaName}' not found`, StatusCode.ERROR);
		}
		schema = foundSchema;
	}

	// Check for existing table/view
	const existingItem = schema.getTable(viewName) ?? schema.getView(viewName);
	if (existingItem) {
		if (stmt.ifNotExists) {
			// Item exists, but IF NOT EXISTS is specified, so it's a no-op.
			compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, `View ${schemaName}.${viewName} already exists (IF NOT EXISTS)`);
			return;
		} else {
			const itemType = ('selectAst' in existingItem) ? 'view' : 'table'; // Check if it's a view or table
			throw new SqliteError(`cannot create ${itemType} ${viewName}: already exists in schema ${schema.name}`, StatusCode.ERROR);
		}
	}

	// Create the ViewSchema object
	const viewSchema: ViewSchema = {
		name: viewName,
		schemaName: schema.name, // Use the actual schema name
		sql: compiler.sql, // Store the original SQL statement text
		selectAst: stmt.select, // Store the parsed SELECT AST
		columns: stmt.columns ? Object.freeze(stmt.columns) : undefined, // Store explicit columns if provided
	};

	// Add the view to the schema
	try {
		schema.addView(viewSchema);
	} catch (e: any) {
		// Catch potential conflicts thrown by schema.addView
		if (e instanceof SqliteError) {
			throw e; // Re-throw schema-level conflict errors
		} else {
			throw new SqliteError(`Error adding view ${viewName} to schema ${schema.name}: ${e.message}`, StatusCode.INTERNAL);
		}
	}

	// CREATE VIEW doesn't produce executable VDBE code itself, just modifies schema
	compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, `Schema definition for VIEW ${schemaName}.${viewName}`);
}

/**
 * Compiles a DROP statement (TABLE, INDEX, VIEW).
 */
export function compileDropStatement(compiler: Compiler, stmt: AST.DropStmt): void {
	const schemaName = stmt.name.schema ?? compiler.db.schemaManager.getCurrentSchemaName();
	const objectName = stmt.name.name;

	let success = false;
	let itemType = stmt.objectType; // 'table', 'view', 'index'

	try {
		switch (stmt.objectType) {
			case 'table':
				success = compiler.db.schemaManager.dropTable(schemaName, objectName);
				break;
			case 'view':
				success = compiler.db.schemaManager.dropView(schemaName, objectName);
				break;
			case 'index': {
				// Find the schema and check if it's a virtual table index
				// We need the table schema to find the VTab instance
				// This requires iterating tables to find which one owns the index, which is inefficient.
				// TODO: Improve schema management to track index->table relationship.
				let tableSchema: TableSchema | undefined;
				const schema = compiler.db.schemaManager.getSchema(schemaName);
				if (schema) {
					for (const ts of schema.getAllTables()) {
						if (ts.indexes?.some(idx => idx.name.toLowerCase() === objectName.toLowerCase())) {
							tableSchema = ts;
							break;
						}
					}
				}

				if (!tableSchema) {
					if (!stmt.ifExists) throw new SqliteError(`no such index: ${objectName}`, StatusCode.ERROR);
					compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, `DROP INDEX ${schemaName}.${objectName} (Not found, IF EXISTS)`);
					success = true; // Report success if IF EXISTS
					break;
				}

				// Check if the virtual table prototype supports xDropIndex
				if (typeof (tableSchema.vtabModule as any)?.prototype?.xDropIndex !== 'function') {
					throw new SqliteError(`Virtual table module '${tableSchema.vtabModuleName}' for table '${tableSchema.name}' does not support DROP INDEX.`, StatusCode.ERROR);
				}

				// Allocate a cursor for the target table
				let cursorIdx = -1;
				for (const [idx, schema] of compiler.tableSchemas.entries()) {
					if (schema === tableSchema) {
						cursorIdx = idx;
						break;
					}
				}
				if (cursorIdx === -1) {
					cursorIdx = compiler.allocateCursor();
					compiler.tableSchemas.set(cursorIdx, tableSchema);
					compiler.emit(Opcode.OpenWrite, cursorIdx, 0, 0, tableSchema, 0, `Open VTab ${tableSchema.name} for DROP INDEX`);
				} else {
					compiler.emit(Opcode.OpenWrite, cursorIdx, 0, 0, tableSchema, 0, `Re-Open VTab ${tableSchema.name} for DROP INDEX`);
				}

				// Emit the VDropIndex opcode, passing index name as p4
				compiler.emit(Opcode.VDropIndex, cursorIdx, 0, 0, objectName, 0, `DROP INDEX ${objectName} ON ${tableSchema.name}`);
				// Close the cursor
				compiler.emit(Opcode.Close, cursorIdx, 0, 0, null, 0, `Close VTab cursor after DROP INDEX`);
				// Invalidate schema cache
				compiler.emit(Opcode.SchemaInvalidate, 0, 0, 0, null, 0, `Invalidate schema after DROP INDEX`);
				success = true; // Indicate VDBE code was generated
				break;
			}
			// case 'trigger': // Add if triggers are supported later
			// 	 success = compiler.db.schemaManager.dropTrigger(schemaName, objectName);
			// 	 break;
			default:
				// Should not happen if parser is correct
				throw new SqliteError(`Unsupported object type for DROP: ${stmt.objectType}`);
		}

		if (!success && !stmt.ifExists) {
			throw new SqliteError(`no such ${itemType}: ${objectName}`, StatusCode.ERROR);
		}

	} catch (e: any) {
		// Re-throw schema-level errors
		if (e instanceof SqliteError) {
			throw e;
		} else {
			throw new SqliteError(`Error dropping ${itemType} ${objectName}: ${e.message}`, StatusCode.INTERNAL);
		}
	}

	// DROP doesn't produce executable VDBE code itself, just modifies schema
	const comment = success
		? `Schema definition drop for ${itemType.toUpperCase()} ${schemaName}.${objectName}`
		: `${itemType.toUpperCase()} ${schemaName}.${objectName} did not exist (IF EXISTS)`;
	compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, comment);
}

export function compileAlterTableStatement(compiler: Compiler, stmt: AST.AlterTableStmt): void {
	const db = compiler.db;
	const schemaName = stmt.table.schema || db.schemaManager.getCurrentSchemaName();
	const tableName = stmt.table.name;

	try {
		const tableSchema = db.schemaManager.getTable(schemaName, tableName);

		if (!tableSchema) {
			throw new SqliteError(`no such table: ${tableName}`, StatusCode.ERROR, undefined, stmt.table.loc?.start.line, stmt.table.loc?.start.column);
		}
		if ('selectAst' in tableSchema) {
			throw new SqliteError(`${tableName} is a view, not a table`, StatusCode.ERROR, undefined, stmt.table.loc?.start.line, stmt.table.loc?.start.column);
		}

		if (stmt.action.type === 'renameTable') {
			compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, `ALTER TABLE ${tableName} RENAME TO ${stmt.action.newName} (handled by DB layer)`);
			compiler.emit(Opcode.SchemaInvalidate, 0, 0, 0, null, 0, `Invalidate schema after RENAME TABLE`);

		} else if (stmt.action.type === 'addColumn' || stmt.action.type === 'dropColumn' || stmt.action.type === 'renameColumn') {
			// Runtime check for xAlterSchema implementation moved to VDBE handler (Opcode.SchemaChange)

			let changeInfo: P4SchemaChange;
			let columnName: string = '';

			switch (stmt.action.type) {
				case 'addColumn':
					columnName = stmt.action.column.name;
					if (tableSchema.columns.some((c: ColumnSchema) => c.name.toLowerCase() === columnName.toLowerCase())) {
						throw new SqliteError(`duplicate column name: ${columnName}`, StatusCode.ERROR, undefined, stmt.loc?.start.line, stmt.loc?.start.column);
					}
					if (stmt.action.column.constraints?.some(c => c.type === 'primaryKey' || c.type === 'unique' || c.type === 'foreignKey')) {
						warnLog(`ALTER TABLE ADD COLUMN with complex constraints (PK, UNIQUE, FK) might not be fully enforced by all VTabs.`);
					}
					changeInfo = { type: 'addColumn', columnDef: stmt.action.column };
					break;

				case 'dropColumn':
					columnName = stmt.action.name;
					const colIndex = tableSchema.columnIndexMap.get(columnName.toLowerCase());
					if (colIndex === undefined) {
						throw new SqliteError(`no such column: ${columnName}`, StatusCode.ERROR, undefined, stmt.loc?.start.line, stmt.loc?.start.column);
					}
					if (tableSchema.primaryKeyDefinition.some((pk: { index: number; desc: boolean }) => pk.index === colIndex)) {
						throw new SqliteError(`cannot drop column ${columnName}: is part of primary key`, StatusCode.CONSTRAINT, undefined, stmt.loc?.start.line, stmt.loc?.start.column);
					}
					changeInfo = { type: 'dropColumn', columnName: columnName };
					break;

				case 'renameColumn':
					const oldName = stmt.action.oldName;
					const newName = stmt.action.newName;
					columnName = oldName;
					const oldColIndex = tableSchema.columnIndexMap.get(oldName.toLowerCase());
					if (oldColIndex === undefined) {
						throw new SqliteError(`no such column: ${oldName}`, StatusCode.ERROR, undefined, stmt.loc?.start.line, stmt.loc?.start.column);
					}
					if (tableSchema.columns.some((c: ColumnSchema) => c.name.toLowerCase() === newName.toLowerCase())) {
						throw new SqliteError(`duplicate column name: ${newName}`, StatusCode.ERROR, undefined, stmt.loc?.start.line, stmt.loc?.start.column);
					}
					if (tableSchema.primaryKeyDefinition.some((pk: { index: number; desc: boolean }) => pk.index === oldColIndex)) {
						throw new SqliteError(`cannot rename column ${oldName}: is part of primary key`, StatusCode.CONSTRAINT, undefined, stmt.loc?.start.line, stmt.loc?.start.column);
					}
					changeInfo = { type: 'renameColumn', oldName: oldName, newName: newName };
					break;
			}

			let cursorIdx = -1;
			for (const [idx, schema] of compiler.tableSchemas.entries()) {
				if (schema === tableSchema) {
					cursorIdx = idx;
					break;
				}
			}
			if (cursorIdx === -1) {
				cursorIdx = compiler.allocateCursor();
				compiler.tableSchemas.set(cursorIdx, tableSchema);
				compiler.emit(Opcode.OpenRead, cursorIdx, 0, 0, tableSchema, 0, `Open VTab ${tableName} for ALTER`);
			} else {
				compiler.emit(Opcode.OpenRead, cursorIdx, 0, 0, tableSchema, 0, `Re-Open VTab ${tableName} for ALTER`);
			}

			compiler.emit(Opcode.SchemaChange, cursorIdx, 0, 0, changeInfo, 0, `ALTER TABLE ${tableName} ${stmt.action.type}`);
			compiler.emit(Opcode.Close, cursorIdx, 0, 0, null, 0, `Close VTab cursor after ALTER`);
			compiler.emit(Opcode.SchemaInvalidate, 0, 0, 0, null, 0, `Invalidate schema after ALTER TABLE`);

		} else {
			throw new SqliteError(`Unsupported ALTER TABLE action type: ${(stmt.action as any).type}`, StatusCode.INTERNAL);
		}

	} catch (e: any) {
		if (e instanceof SqliteError) throw e;
		throw new SqliteError(`Error processing ALTER TABLE: ${e.message}`, StatusCode.INTERNAL, e instanceof Error ? e : undefined);
	}
}

export function compileBeginStatement(compiler: Compiler, stmt: AST.BeginStmt): void {
	compiler.emit(Opcode.VBegin, 0, 0, 0, null, 0, `BEGIN ${stmt.mode || 'DEFERRED'}`);
}

export function compileCommitStatement(compiler: Compiler, stmt: AST.CommitStmt): void {
	compiler.emit(Opcode.VCommit, 0, 0, 0, null, 0, "COMMIT");
}

export function compilePragmaStatement(compiler: Compiler, stmt: AST.PragmaStmt): void {
	const db = compiler.db;
	const pragmaName = stmt.name; // Already lowercased by parser
	const valueNode = stmt.value;

	// Helper to get string value from LiteralExpr or IdentifierExpr
	const getStringValue = (node: AST.LiteralExpr | AST.IdentifierExpr | undefined): string | null => {
		if (!node) return null;
		if (node.type === 'literal') {
			return node.value === null ? null : String(node.value);
		} else if (node.type === 'identifier') {
			return node.name; // Use identifier name directly
		}
		return null;
	};

	switch (pragmaName) {
		case 'default_vtab_module': {
			const moduleName = getStringValue(valueNode);
			if (moduleName === null) {
				throw new SqliteError(`PRAGMA default_vtab_module requires a string or identifier value.`, StatusCode.ERROR, undefined, stmt.loc?.start.line, stmt.loc?.start.column);
			}
			// We modify the setter slightly to only take the name here
			// The args are set by a separate pragma
			log(`Setting default VTab module to: %s`, moduleName);
			db.setDefaultVtabName(moduleName); // New dedicated method
			break;
		}
		case 'default_vtab_args': {
			const argsJsonString = getStringValue(valueNode);
			if (argsJsonString === null) {
				// PRAGMA default_vtab_args = NULL; clears the args
				log("Clearing default VTab args.");
				db.setDefaultVtabArgsFromJson("[]"); // Pass empty JSON array string
			} else {
				log(`Setting default VTab args from JSON: %s`, argsJsonString);
				db.setDefaultVtabArgsFromJson(argsJsonString); // New dedicated method
			}
			break;
		}
		// TODO: Add other PRAGMAs here later (e.g., schema_version, user_version, foreign_keys)
		default:
			// Treat unknown pragmas as no-ops for now, like SQLite often does
			warnLog(`Ignoring unrecognized PRAGMA: %s`, pragmaName);
			break;
	}

	// Pragmas modify DB state directly, no VDBE code generated
	compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, `PRAGMA ${pragmaName}`);
}

// Helper to parse primary key from constraints AST
export function parsePrimaryKeyFromAst(
	columns: ReadonlyArray<AST.ColumnDef>,
	constraints: ReadonlyArray<AST.TableConstraint> | undefined // Allow undefined constraints
): ReadonlyArray<{ index: number; desc: boolean }> | undefined {
	const colMap = new Map<string, number>();
	columns.forEach((col, idx) => colMap.set(col.name.toLowerCase(), idx));
	let pkDef: { index: number; desc: boolean }[] = [];
	let foundPk = false;

	// Check table constraints
	if (constraints) {
		for (const constraint of constraints) {
			if (constraint.type === 'primaryKey' && constraint.columns) {
				if (foundPk) throw new Error("Multiple primary keys defined");
				foundPk = true;
				pkDef = constraint.columns.map(colInfo => {
					const index = colMap.get(colInfo.name.toLowerCase());
					if (index === undefined) throw new Error(`PK column ${colInfo.name} not found`);
					return { index, desc: colInfo.direction === 'desc' };
				});
				break; // Only one table-level PK allowed
			}
		}
	}

	// Check column constraints if no table constraint found
	if (!foundPk) {
		columns.forEach((colDef, index) => {
			const pkConstraint = colDef.constraints.find(c => c.type === 'primaryKey');
			if (pkConstraint) {
				if (foundPk) throw new Error("Multiple primary keys defined (column + table/column)");
				foundPk = true;
				pkDef = [{ index, desc: pkConstraint.direction === 'desc' }];
				// Cannot break here easily, still need to check all columns for multiple definitions
			}
		});
	}

	return pkDef.length > 0 ? Object.freeze(pkDef) : undefined;
}

// Helper to determine affinity from type name string
export function getAffinityFromTypeName(typeName: string | undefined): SqlDataType {
	const typeUpper = typeName?.toUpperCase() || '';
	if (typeUpper.includes('INT')) return SqlDataType.INTEGER;
	if (typeUpper.includes('REAL') || typeUpper.includes('FLOAT') || typeUpper.includes('DOUBLE')) return SqlDataType.REAL;
	if (typeUpper.includes('BLOB')) return SqlDataType.BLOB;
	if (typeUpper.includes('BOOL')) return SqlDataType.INTEGER; // Booleans often stored as int
	return SqlDataType.TEXT;
}
