import { Schema } from './schema';
import type { Database } from '../core/database'; // Use Database type
import type { TableSchema } from './table';
import type { FunctionSchema } from './function';
import { SqliteError } from '../common/errors';
import { StatusCode, SqlDataType } from '../common/constants';
import type { VirtualTable } from '../vtab/table';
import type { ColumnSchema } from './column';
import { createDefaultColumnSchema } from './column';
import { buildColumnIndexMap, findPrimaryKeyColumns } from './table';
import { Parser } from '../parser/parser'; // Import the parser
import type * as AST from '../parser/ast'; // Import AST types

/**
 * Manages all schemas associated with a database connection (main, temp, attached).
 * Handles lookup resolution according to SQLite's rules.
 */
export class SchemaManager {
	private readonly db: Database;
	private schemas: Map<string, Schema> = new Map();

	constructor(db: Database) {
		this.db = db;
		// Ensure 'main' and 'temp' schemas always exist
		this.schemas.set('main', new Schema('main'));
		this.schemas.set('temp', new Schema('temp'));
	}

	/** Gets a specific schema by name, or undefined if not found. */
	getSchema(name: string): Schema | undefined {
		return this.schemas.get(name.toLowerCase());
	}

	/** Gets the 'main' schema. */
	getMainSchema(): Schema {
		return this.schemas.get('main')!; // Should always exist
	}

	/** Gets the 'temp' schema. */
	getTempSchema(): Schema {
		return this.schemas.get('temp')!; // Should always exist
	}

	/** Adds a schema (e.g., for ATTACH). Throws if name conflicts. */
	addSchema(name: string): Schema {
		const lowerName = name.toLowerCase();
		if (this.schemas.has(lowerName)) {
			throw new SqliteError(`Schema '${name}' already exists`, StatusCode.ERROR);
		}
		const schema = new Schema(name);
		this.schemas.set(lowerName, schema);
		console.log(`SchemaManager: Added schema '${name}'`);
		return schema;
	}

	/** Removes a schema (e.g., for DETACH). Returns true if found and removed. */
	removeSchema(name: string): boolean {
		const lowerName = name.toLowerCase();
		if (lowerName === 'main' || lowerName === 'temp') {
			throw new SqliteError(`Cannot detach schema '${name}'`, StatusCode.ERROR);
		}
		const schema = this.schemas.get(lowerName);
		if (schema) {
			// TODO: Need to ensure associated VTabs are disconnected/destroyed?
			// This might require iterating tables and calling module methods.
			// For now, just remove the schema container.
			schema.clearFunctions(); // Call function destructors
			schema.clearTables();
			this.schemas.delete(lowerName);
			console.log(`SchemaManager: Removed schema '${name}'`);
			return true;
		}
		return false;
	}

	/**
	 * Finds a table by name, searching schemas according to SQLite rules.
	 * If dbName is provided, searches only that schema.
	 * Otherwise, searches current (usually 'main'), then 'temp'.
	 * (Note: Attach search order would be added later if needed).
	 * @param tableName Name of the table.
	 * @param dbName Optional specific schema name to search.
	 * @returns The TableSchema or undefined if not found.
	 */
	findTable(tableName: string, dbName?: string | null): TableSchema | undefined {
		if (dbName) {
			const schema = this.schemas.get(dbName.toLowerCase());
			return schema?.getTable(tableName);
		} else {
			// Default search order: main, then temp
			return this.getMainSchema().getTable(tableName)
				?? this.getTempSchema().getTable(tableName);
			// TODO: Add attached database lookup logic here if ATTACH is implemented
		}
	}

	/**
	* Finds a function by name and arg count, searching schemas.
	* SQLite looks in the connection-global space first, then potentially schema-specific?
	* For now, let's assume functions are global across the connection (simpler).
	* We'll register them on the 'main' schema internally, but lookup won't require schema name.
	* @param funcName Name of the function.
	* @param nArg Number of arguments.
	* @returns The FunctionSchema or undefined if not found.
	*/
	findFunction(funcName: string, nArg: number): FunctionSchema | undefined {
		// Simplified: Assume functions are connection-global for now
		// Look up in the 'main' schema where we store them
		return this.getMainSchema().getFunction(funcName, nArg);
	}

	/**
	 * Declares a virtual table's schema based on a CREATE VIRTUAL TABLE string.
	 * This is intended to be called from VTab `xCreate`/`xConnect` methods.
	 * @param schemaName The schema the table belongs to ('main', 'temp', etc.)
	 * @param createVirtualTableSql The full `CREATE VIRTUAL TABLE ...` string.
	 * @param associatedVtab The VirtualTable instance to link.
	 * @param auxData The auxData associated with the module registration.
	 * @returns The created TableSchema.
	 * @throws SqliteError on parsing or definition errors.
	 */
	declareVtab(
		schemaName: string,
		createVirtualTableSql: string, // Expecting full CREATE VIRTUAL TABLE statement
		associatedVtab: VirtualTable,
		auxData?: unknown,
		// vtabArgs are now parsed from the SQL
	): TableSchema {
		const schema = this.schemas.get(schemaName.toLowerCase());
		if (!schema) {
			throw new SqliteError(`Schema not found: ${schemaName}`, StatusCode.ERROR);
		}

		console.log(`SchemaManager: Declaring VTab in '${schemaName}' using SQL: ${createVirtualTableSql}`);

		// --- Use the Parser ---
		let createVtabAst: AST.CreateVirtualTableStmt;
		try {
			const parser = new Parser();
			const ast = parser.parse(createVirtualTableSql);
			if (ast.type !== 'createVirtualTable') {
				throw new SqliteError(`Expected CREATE VIRTUAL TABLE statement, got ${ast.type}`, StatusCode.ERROR);
			}
			createVtabAst = ast as AST.CreateVirtualTableStmt;
		} catch (e: any) {
			throw new SqliteError(`Failed to parse CREATE VIRTUAL TABLE statement: ${e.message}`, StatusCode.ERROR);
		}

		const tableName = createVtabAst.table.name;
		const vtabArgs = createVtabAst.moduleArgs; // Get args from AST

		if (schema.getTable(tableName)) {
			// Handle IF NOT EXISTS
			if (createVtabAst.ifNotExists) {
				console.log(`SchemaManager: VTab ${tableName} already exists in schema ${schemaName}, skipping creation (IF NOT EXISTS).`);
				// Return existing schema? Or should xCreate/xConnect handle this?
				// For now, let's return the existing one, assuming xConnect logic handles it.
				return schema.getTable(tableName)!;
			}
			throw new SqliteError(`Table ${tableName} already exists in schema ${schemaName}`, StatusCode.ERROR);
		}

		// --- Simplified Column Definition (Placeholder) ---
		// A robust implementation requires the module to provide its schema definition,
		// often by parsing the arguments passed (vtabArgs) or having a predefined structure.
		// The `CREATE VIRTUAL TABLE` statement itself doesn't define columns directly.
		// For now, we create a placeholder schema. Modules like MemoryTable will
		// override this with their actual columns during their setup.
		console.warn(`SchemaManager.declareVtab: Using placeholder column definition for ${tableName}. VTab module should define actual columns.`);
		const placeholderColumns: ColumnSchema[] = [
			createDefaultColumnSchema('column1'),
			createDefaultColumnSchema('column2')
		];
		// --- End Simplified Column Definition ---

		const tableSchema: TableSchema = {
			name: tableName,
			schemaName: schema.name,
			columns: Object.freeze(placeholderColumns),
			columnIndexMap: Object.freeze(buildColumnIndexMap(placeholderColumns)),
			primaryKeyColumns: Object.freeze(findPrimaryKeyColumns(placeholderColumns)),
			isVirtual: true,
			vtabModule: associatedVtab.module,
			vtabInstance: associatedVtab,
			vtabAuxData: auxData,
			vtabArgs: Object.freeze(vtabArgs || []), // Use parsed args
		};

		schema.addTable(tableSchema);
		return tableSchema;
	}

	/** Clears all schemas except main and temp, releasing resources. */
	clearAll(disconnectVt = true): void {
		// TODO: Implement proper VTab disconnect/destroy logic here before clearing
		console.warn("SchemaManager.clearAll() - VTab disconnect/destroy not fully implemented yet.");
		this.schemas.forEach((schema, name) => {
			if (name !== 'main' && name !== 'temp') {
				// Potentially iterate tables and call xDisconnect/xDestroy?
				schema.clearFunctions(); // Call function destructors
				schema.clearTables();
				this.schemas.delete(name);
			} else {
				// Clear contents of main/temp but keep the schema objects
				schema.clearFunctions();
				// Should we clear tables from main/temp? Depends on desired persistence level.
				// For purely transient, maybe yes. Let's clear for now.
				schema.clearTables();
			}
		});

	}
}
