import type { Compiler } from "./compiler";
import type * as AST from "../parser/ast";
import { StatusCode } from "../common/constants";
import { SqliteError } from "../common/errors";
import { stringifyCreateTable } from "../util/ddl-stringify";
import { Opcode } from "../common/constants";
import type { Database } from '../core/database';
import type { VirtualTable } from "../vtab/table";
import type { ViewSchema } from '../schema/view';
import type { Schema } from '../schema/schema';

export function compileCreateTableStatement(compiler: Compiler, stmt: AST.CreateTableStmt): void {
	const db = compiler.db;
	const schemaName = stmt.table.schema || 'main';
	const tableName = stmt.table.name;

	let moduleName: string;
	let moduleArgs: string[];
	let synthesizeDdlArg = false;

	if (stmt.moduleName) {
		moduleName = stmt.moduleName;
		moduleArgs = stmt.moduleArgs || [];
	} else {
		const defaultVtab = db.getDefaultVtabModule();
		moduleName = defaultVtab.name;
		moduleArgs = [...defaultVtab.args];
		if (moduleName.toLowerCase() === 'memory') {
			synthesizeDdlArg = true;
		}
	}

	const moduleInfo = db._getVtabModule(moduleName);
	if (!moduleInfo) {
		throw new SqliteError(`No virtual table module named '${moduleName}'`, StatusCode.ERROR, undefined, stmt.loc?.start.line, stmt.loc?.start.column);
	}

	const finalArgs: string[] = [
		moduleName,
		schemaName,
		tableName,
	];

	if (synthesizeDdlArg) {
		const ddlString = stringifyCreateTable(stmt);
		finalArgs.push(ddlString);
		finalArgs.push(...moduleArgs);
	} else {
		finalArgs.push(...moduleArgs);
	}

	let tableInstance: VirtualTable;
	try {
		tableInstance = moduleInfo.module.xCreate(db, moduleInfo.auxData, Object.freeze(finalArgs));
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
	compiler.emit(Opcode.Noop, 0, 0, 0, null, 0, "ALTER TABLE (no-op in VDBE)");
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
