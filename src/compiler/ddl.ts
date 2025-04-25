import type { Compiler } from "./compiler";
import type * as AST from "../parser/ast";
import { StatusCode, SqlDataType } from "../common/constants";
import { SqliteError } from "../common/errors";
import { createTableToString } from "../util/ddl-stringify";
import { Opcode } from '../vdbe/opcodes';
import type { Database } from '../core/database';
import type { VirtualTable } from "../vtab/table";
import type { ViewSchema } from '../schema/view';
import type { Schema } from '../schema/schema';
import { Parser } from "../parser/parser";
import type { SqlValue } from "../common/types";
import type { BaseModuleConfig } from '../vtab/module';
import type { Expression } from '../parser/ast';
import type { P4SchemaChange } from "../vdbe/instruction";
import type { VirtualTableModule } from "../vtab/module";
import { columnDefToSchema } from "../schema/table";
import type { ColumnSchema } from "../schema/column";

// Define local interfaces if not exported/importable easily
interface MemoryTableConfig extends BaseModuleConfig {
	columns: { name: string, type: SqlDataType, collation?: string }[];
	primaryKey?: ReadonlyArray<{ index: number; desc: boolean }>;
	checkConstraints?: ReadonlyArray<{ name?: string, expr: Expression }>;
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
			let columns: { name: string, type: SqlDataType, collation?: string }[];
			let primaryKey: ReadonlyArray<{ index: number; desc: boolean }> | undefined;
			let checkConstraints: { name?: string, expr: Expression }[] = [];

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
				// TODO: Extract collation from AST if needed
				columns = createTableAst.columns.map(c => ({ name: c.name, type: getAffinityFromTypeName(c.dataType) }));
				primaryKey = parsePrimaryKeyFromAst(createTableAst.columns, createTableAst.constraints);
				// Gather checks from parsed DDL AST
				createTableAst.columns.forEach(colDef => {
					colDef.constraints?.forEach(con => {
						if (con.type === 'check' && con.expr) {
							checkConstraints.push({ name: con.name, expr: con.expr });
						}
					});
				});
				createTableAst.constraints?.forEach(con => {
					if (con.type === 'check' && con.expr) {
						checkConstraints.push({ name: con.name, expr: con.expr });
					}
				});
				// TODO: Parse readOnly from subsequent args if desired? e.g., USING memory(ddl, 'readOnly=true')
			} else {
				// Case: CREATE TABLE ... ; (Implicitly uses default memory module)
				// Use columns/constraints directly from the main statement's AST
				if (!stmt.columns || stmt.columns.length === 0) {
					throw new Error("Cannot create implicit memory table without column definitions.");
				}
				// TODO: Extract collation from AST if needed
				columns = stmt.columns.map(c => ({ name: c.name, type: getAffinityFromTypeName(c.dataType) }));
				primaryKey = parsePrimaryKeyFromAst(stmt.columns, stmt.constraints || []);
				// Gather checks from main statement AST
				stmt.columns.forEach(colDef => {
					colDef.constraints?.forEach(con => {
						if (con.type === 'check' && con.expr) {
							checkConstraints.push({ name: con.name, expr: con.expr });
						}
					});
				});
				stmt.constraints?.forEach(con => {
					if (con.type === 'check' && con.expr) {
						checkConstraints.push({ name: con.name, expr: con.expr });
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
			console.warn(`Compiler creating generic BaseModuleConfig for module '${moduleName}'. Module may need specific argument parsing.`);
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
			console.log(`Skipping CREATE TABLE: Table ${schemaName}.${tableName} already exists (IF NOT EXISTS).`);
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
		console.warn(`VTab module ${moduleName} created table ${tableName} in schema ${tableInstance.tableSchema.schemaName}, but expected ${schemaName}.`);
		(tableInstance.tableSchema as any).schemaName = schemaName;
	}
	if (!tableInstance.tableSchema.vtabModuleName) {
		(tableInstance.tableSchema as any).vtabModuleName = moduleName;
	}
	if (!tableInstance.tableSchema.vtabArgs) {
		(tableInstance.tableSchema as any).vtabArgs = Object.freeze(moduleArgs);
	}

	schema.addTable(tableInstance.tableSchema);

	console.log(`Successfully created table ${schemaName}.${tableName} using module ${moduleName}`);
	compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, `CREATE TABLE ${tableName}`);
}

export function compileCreateIndexStatement(compiler: Compiler, stmt: AST.CreateIndexStmt): void {
	compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, "CREATE INDEX (no-op in VDBE)");
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
			case 'index':
				// Dropping indexes might require more complex handling (e.g., finding associated table)
				// For now, assume SchemaManager handles it or we add specific logic later.
				// success = compiler.db.schemaManager.dropIndex(schemaName, objectName);
				compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, `DROP INDEX ${schemaName}.${objectName} (Not fully implemented)`);
				success = true; // Assume success for now to avoid error below
				itemType = 'index'; // Ensure correct item type for error message
				console.warn(`DROP INDEX compilation is a placeholder.`);
				break;
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
			// Check if it's a virtual table with a module defined in the schema
			if (!tableSchema.isVirtual || !tableSchema.vtabModule) {
				throw new SqliteError(`ALTER TABLE ${stmt.action.type} is only supported for virtual tables with a defined module`, StatusCode.ERROR, undefined, stmt.table.loc?.start.line, stmt.table.loc?.start.column);
			}
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
						console.warn(`ALTER TABLE ADD COLUMN with complex constraints (PK, UNIQUE, FK) might not be fully enforced by all VTabs.`);
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
			console.log(`Setting default VTab module to: ${moduleName}`);
			db.setDefaultVtabName(moduleName); // New dedicated method
			break;
		}
		case 'default_vtab_args': {
			const argsJsonString = getStringValue(valueNode);
			if (argsJsonString === null) {
				// PRAGMA default_vtab_args = NULL; clears the args
				console.log("Clearing default VTab args.");
				db.setDefaultVtabArgsFromJson("[]"); // Pass empty JSON array string
			} else {
				console.log(`Setting default VTab args from JSON: ${argsJsonString}`);
				db.setDefaultVtabArgsFromJson(argsJsonString); // New dedicated method
			}
			break;
		}
		// TODO: Add other PRAGMAs here later (e.g., schema_version, user_version, foreign_keys)
		default:
			// Treat unknown pragmas as no-ops for now, like SQLite often does
			console.warn(`Ignoring unrecognized PRAGMA: ${pragmaName}`);
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
