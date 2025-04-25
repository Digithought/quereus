import { MisuseError, SqliteError } from '../common/errors';
import { StatusCode } from '../common/constants';
import type { VirtualTableModule } from '../vtab/module';
import { Statement } from './statement';
import type { SqlValue } from '../common/types';
import { SchemaManager } from '../schema/manager';
import type { TableSchema } from '../schema/table';
import type { ColumnSchema } from '../schema/column';
import type { FunctionSchema } from '../schema/function';
// Placeholder for Function management
// import { FunctionManager } from '../func/manager';
import { BUILTIN_FUNCTIONS } from '../func/builtins'; // Import built-ins
import { createScalarFunction, createAggregateFunction } from '../func/registration'; // Import registration helpers
import { FunctionFlags } from '../common/constants'; // Import FunctionFlags
import { SqlDataType } from '../common/constants';
import type { JsonDatabaseSchema, JsonSchema, JsonTableSchema, JsonColumnSchema, JsonFunctionSchema } from './json-schema';
import { Parser } from '../parser/parser';
import { Compiler } from '../compiler/compiler';
import { buildColumnIndexMap, findPrimaryKeyDefinition } from '../schema/table'; // Import helpers
// Import default modules
import { MemoryTableModule } from '../vtab/memory/module';
import { JsonEachModule } from '../vtab/json/each';
import { JsonTreeModule } from '../vtab/json/tree'; // Import JsonTreeModule
// --- Import SchemaTableModule ---
import { SchemaTableModule } from '../vtab/schema/table';
// -------------------------------
// Add import for collation functions
import { registerCollation as registerCollationUtil, getCollation as getCollationUtil, type CollationFunction, BINARY_COLLATION, NOCASE_COLLATION, RTRIM_COLLATION } from '../util/comparison';
// Import schema serialization functions
import { exportSchemaJson as exportSchemaJsonUtil, importSchemaJson as importSchemaJsonUtil } from '../schema/serialization';

/**
 * Represents a connection to an SQLite database (in-memory in this port).
 * Manages schema, prepared statements, virtual tables, and functions.
 */
export class Database {
	public readonly schemaManager: SchemaManager;
	// private readonly funcManager: FunctionManager;
	private isOpen = true;
	private statements = new Set<Statement>();
	private registeredVTabs: Map<string, { module: VirtualTableModule<any, any>, auxData: unknown }> = new Map();
	// Function registration now delegated to SchemaManager/Schema
	// private registeredFuncs: Map<string, { /* function details */ }> = new Map();
	private isAutocommit = true; // Manages transaction state
	private inTransaction = false;
	// --- Add default module config ---
	private defaultVtabModuleName: string = 'memory';
	private defaultVtabModuleArgs: string[] = [];
	// -------------------------------

	constructor() {
		this.schemaManager = new SchemaManager(this);
		// this.funcManager = new FunctionManager(this);
		// Initialize default VFS, schema, etc. if needed
		console.log("Database instance created.");

		// Register built-in functions
		this.registerBuiltinFunctions();
		// Register default virtual table modules
		this.registerVtabModule('memory', new MemoryTableModule());
		this.registerVtabModule('json_each', new JsonEachModule());
		this.registerVtabModule('json_tree', new JsonTreeModule()); // Register JsonTreeModule
		this.registerVtabModule('sqlite_schema', new SchemaTableModule()); // Register SchemaTableModule
		// Register built-in collations
		this.registerDefaultCollations();
	}

	/** @internal Registers default built-in SQL functions */
	private registerBuiltinFunctions(): void {
		const mainSchema = this.schemaManager.getMainSchema();
		BUILTIN_FUNCTIONS.forEach(funcDef => {
			try {
				mainSchema.addFunction(funcDef);
			} catch (e) {
				console.error(`Failed to register built-in function ${funcDef.name}/${funcDef.numArgs}:`, e);
			}
		});
		console.log(`Registered ${BUILTIN_FUNCTIONS.length} built-in functions.`);
	}

	/** @internal Registers default collation sequences */
	private registerDefaultCollations(): void {
		// Register the built-in collations
		registerCollationUtil('BINARY', BINARY_COLLATION);
		registerCollationUtil('NOCASE', NOCASE_COLLATION);
		registerCollationUtil('RTRIM', RTRIM_COLLATION);
		console.log("Default collations registered (BINARY, NOCASE, RTRIM)");
	}

	/**
	 * Prepares an SQL statement for execution.
	 * @param sql The SQL string to prepare.
	 * @returns A Promise resolving to the prepared Statement object.
	 * @throws SqliteError on failure (e.g., syntax error).
	 */
	async prepare(sql: string): Promise<Statement> {
		if (!this.isOpen) {
			throw new MisuseError("Database is closed");
		}
		console.log(`Preparing SQL: ${sql}`);

		// Create the statement
		const stmt = new Statement(this, sql);

		try {
			// Add to active statements list
			this.statements.add(stmt);

			return stmt;
		} catch (error) {
			// Clean up if prepare fails
			this.statements.delete(stmt);
			throw error;
		}
	}

	/**
	 * Executes one or more SQL statements directly.
	 * @param sql The SQL string(s) to execute.
	 * @param params Optional parameters to bind (array or object).
	 * @param callback Optional callback to process result rows.
	 * @returns A Promise resolving when execution completes.
	 * @throws SqliteError on failure.
	 */
	async exec(
		sql: string,
		params?: SqlValue[] | Record<string, SqlValue> | ((row: Record<string, SqlValue>, columns: string[]) => void),
		callback?: (row: Record<string, SqlValue>, columns: string[]) => void
	): Promise<void> {
		if (!this.isOpen) {
			throw new MisuseError("Database is closed");
		}

		// Check if the first argument is the callback (no params)
		if (typeof params === 'function' && callback === undefined) {
			callback = params as (row: Record<string, SqlValue>, columns: string[]) => void;
			params = undefined;
		}

		console.log(`Executing SQL: ${sql}`);

		// TODO: Split multiple statements
		// For now, we'll assume a single statement

		const stmt = await this.prepare(sql);

		try {
			// Bind parameters if provided
			if (params && typeof params !== 'function') {
				stmt.bindAll(params);
			}

			// Execute the statement
			let result = await stmt.step();

			while (result === StatusCode.ROW) {
				// Process row if callback provided
				if (callback) {
					const rowData = stmt.getAsObject();
					const colNames = stmt.getColumnNames();
					callback(rowData, colNames);
				}

				// Step to next row
				result = await stmt.step();
			}

			if (result !== StatusCode.DONE && result !== StatusCode.OK) {
				throw new SqliteError("Execution failed", result);
			}
		} finally {
			// Always finalize the statement
			await stmt.finalize();
		}
	}

	/**
	 * Registers a virtual table module.
	 * @param name The name of the module.
	 * @param module The module implementation.
	 * @param auxData Optional client data passed to xCreate/xConnect.
	 */
	registerVtabModule(name: string, module: VirtualTableModule<any, any>, auxData?: unknown): void {
		if (!this.isOpen) {
			throw new MisuseError("Database is closed");
		}

		const lowerName = name.toLowerCase();
		if (this.registeredVTabs.has(lowerName)) {
			throw new SqliteError(`Virtual table module '${name}' already registered`, StatusCode.ERROR);
		}

		console.log(`Registering VTab module: ${name}`);
		this.registeredVTabs.set(lowerName, { module, auxData });
	}

	// Function registration is now handled via SchemaManager / Schema
	// registerFunction(...) // Removed from here

	/**
	 * Begins a transaction.
	 * @param mode Transaction mode ('deferred', 'immediate', or 'exclusive').
	 */
	async beginTransaction(mode: 'deferred' | 'immediate' | 'exclusive' = 'deferred'): Promise<void> {
		if (!this.isOpen) {
			throw new MisuseError("Database is closed");
		}

		if (this.inTransaction) {
			throw new SqliteError("Transaction already active", StatusCode.ERROR);
		}

		await this.exec(`BEGIN ${mode.toUpperCase()} TRANSACTION`);
		this.inTransaction = true;
		this.isAutocommit = false;
	}

	/**
	 * Commits the current transaction.
	 */
	async commit(): Promise<void> {
		if (!this.isOpen) {
			throw new MisuseError("Database is closed");
		}

		if (!this.inTransaction) {
			throw new SqliteError("No transaction active", StatusCode.ERROR);
		}

		await this.exec("COMMIT");
		this.inTransaction = false;
		this.isAutocommit = true;
	}

	/**
	 * Rolls back the current transaction.
	 */
	async rollback(): Promise<void> {
		if (!this.isOpen) {
			throw new MisuseError("Database is closed");
		}

		if (!this.inTransaction) {
			throw new SqliteError("No transaction active", StatusCode.ERROR);
		}

		await this.exec("ROLLBACK");
		this.inTransaction = false;
		this.isAutocommit = true;
	}

	/**
	 * Closes the database connection and releases resources.
	 * @returns A promise resolving on completion.
	 */
	async close(): Promise<void> {
		if (!this.isOpen) {
			return;
		}

		console.log("Closing database...");
		this.isOpen = false;

		// Finalize all prepared statements
		const finalizePromises = Array.from(this.statements).map(stmt => stmt.finalize());
		await Promise.allSettled(finalizePromises); // Wait even if some fail
		this.statements.clear();

		// Clear schemas, ensuring VTabs are potentially disconnected
		this.schemaManager.clearAll();

		this.registeredVTabs.clear();
		// Registered functions are cleared within schemaManager.clearAll()
		console.log("Database closed.");
	}

	// --- Internal methods called by Statement ---

	/** @internal Called by Statement when it's finalized */
	_statementFinalized(stmt: Statement): void {
		this.statements.delete(stmt);
	}

	// --- Potentially public helper methods ---

	/** Checks if the database connection is in autocommit mode. */
	getAutocommit(): boolean {
		if (!this.isOpen) {
			throw new MisuseError("Database is closed");
		}
		return this.isAutocommit;
	}

	/**
	 * Programmatically defines or replaces a virtual table in the 'main' schema.
	 * This is an alternative/supplement to using `CREATE VIRTUAL TABLE`.
	 * @param definition The schema definition for the table.
	 */
	defineVirtualTable(definition: TableSchema): void {
		if (!this.isOpen) throw new MisuseError("Database is closed");
		if (!definition.isVirtual || !definition.vtabModule) {
			throw new MisuseError("Definition must be for a virtual table with a module");
		}
		if (definition.schemaName !== 'main') {
			throw new MisuseError("Programmatic definition only supported for 'main' schema currently");
		}

		this.schemaManager.getMainSchema().addTable(definition);
	}

	// TODO: Add methods for programmatic schema definition if needed
	// defineTable(...) - For regular tables (if ever needed)
	// defineFunction(...) - Wraps schemaManager.getMainSchema().addFunction(...)

	// Internal accessors used by parser/planner/VDBE
	/** @internal */
	_getVtabModule(name: string): { module: VirtualTableModule<any, any>, auxData: unknown } | undefined {
		return this.registeredVTabs.get(name.toLowerCase());
	}

	/** @internal */
	_findTable(tableName: string, dbName?: string | null): TableSchema | undefined {
		return this.schemaManager.findTable(tableName, dbName);
	}

	/** @internal */
	_findFunction(funcName: string, nArg: number): FunctionSchema | undefined {
		return this.schemaManager.findFunction(funcName, nArg);
	}

	/**
	 * Registers a user-defined scalar function.
	 *
	 * @param name The name of the SQL function.
	 * @param options Configuration: { numArgs: number, deterministic?: boolean, flags?: number }.
	 * @param func The JavaScript function implementation.
	 */
	createScalarFunction(
		name: string,
		options: {
			numArgs: number;
			deterministic?: boolean;
			flags?: number; // Allow overriding flags completely
		},
		func: (...args: any[]) => SqlValue
	): void {
		if (!this.isOpen) throw new MisuseError("Database is closed");

		const baseFlags = options.deterministic ? FunctionFlags.DETERMINISTIC | FunctionFlags.UTF8 : FunctionFlags.UTF8;
		const flags = options.flags ?? baseFlags;

		const schema = createScalarFunction(
			{ name, numArgs: options.numArgs, flags },
			func
		);

		try {
			this.schemaManager.getMainSchema().addFunction(schema);
		} catch (e) {
			console.error(`Failed to register scalar function ${name}/${options.numArgs}:`, e);
			if (e instanceof Error) throw e; else throw new Error(String(e));
		}
	}

	/**
	 * Registers a user-defined aggregate function.
	 *
	 * @param name The name of the SQL function.
	 * @param options Configuration: { numArgs: number, flags?: number, initialState?: any }.
	 * @param stepFunc The function called for each row (accumulator, ...args) => newAccumulator.
	 * @param finalFunc The function called at the end (accumulator) => finalResult.
	 */
	createAggregateFunction(
		name: string,
		options: {
			numArgs: number;
			flags?: number;
			initialState?: any;
		},
		stepFunc: (acc: any, ...args: any[]) => any,
		finalFunc: (acc: any) => SqlValue
	): void {
		if (!this.isOpen) throw new MisuseError("Database is closed");

		const flags = options.flags ?? FunctionFlags.UTF8;

		const schema = createAggregateFunction(
			{ name, numArgs: options.numArgs, flags, initialState: options.initialState },
			stepFunc,
			finalFunc
		);

		try {
			this.schemaManager.getMainSchema().addFunction(schema);
		} catch (e) {
			console.error(`Failed to register aggregate function ${name}/${options.numArgs}:`, e);
			if (e instanceof Error) throw e; else throw new Error(String(e));
		}
	}

	/**
	 * Registers a function using a pre-defined FunctionSchema.
	 * This is the lower-level registration method.
	 *
	 * @param schema The FunctionSchema object describing the function.
	 */
	registerFunction(schema: FunctionSchema): void {
		if (!this.isOpen) throw new MisuseError("Database is closed");
		try {
			// Register directly with the main schema
			this.schemaManager.getMainSchema().addFunction(schema);
		} catch (e) {
			console.error(`Failed to register function ${schema.name}/${schema.numArgs}:`, e);
			if (e instanceof Error) throw e; else throw new Error(String(e));
		}
	}

	/**
	 * Exports the current database schema (tables and function signatures)
	 * to a JSON string.
	 * @returns A JSON string representing the schema.
	 */
	exportSchemaJson(): string {
		return exportSchemaJsonUtil(this);
	}

	/**
	 * Imports a database schema from a JSON string.
	 * Clears existing non-core schemas (like attached) before importing.
	 * Function implementations must be re-registered manually after import.
	 * Virtual tables will need to be reconnected (potentially requires a separate step or lazy connect).
	 * @param jsonString The JSON string representing the schema.
	 * @throws Error on parsing errors or invalid schema format.
	 */
	importSchemaJson(jsonString: string): void {
		importSchemaJsonUtil(this, jsonString);
	}

	/**
	 * @deprecated Use setDefaultVtabName and setDefaultVtabArgsFromJson via PRAGMA instead.
	 * Sets the default virtual table module used when CREATE TABLE is called
	 * without a USING clause.
	 */
	setDefaultVtabModule(name: string, args: string[] = []): void {
		console.warn("Deprecated: Use `PRAGMA default_vtab_module` and `PRAGMA default_vtab_args` instead.");
		this.setDefaultVtabName(name);
		this.setDefaultVtabArgs(args); // Keep internal helper
	}

	/** @internal Sets only the name of the default module */
	setDefaultVtabName(name: string): void {
		if (!this.registeredVTabs.has(name.toLowerCase())) {
			console.warn(`Setting default VTab module to '${name}', which is not currently registered.`);
		}
		this.defaultVtabModuleName = name;
	}

	/** @internal Sets the default args directly */
	private setDefaultVtabArgs(args: string[]): void {
		this.defaultVtabModuleArgs = [...args]; // Store a copy
	}

	/** @internal Sets the default args by parsing a JSON string */
	setDefaultVtabArgsFromJson(argsJsonString: string): void {
		try {
			const parsedArgs = JSON.parse(argsJsonString);
			if (!Array.isArray(parsedArgs) || !parsedArgs.every(arg => typeof arg === 'string')) {
				throw new Error("JSON value must be an array of strings.");
			}
			this.setDefaultVtabArgs(parsedArgs);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			throw new SqliteError(`Invalid JSON for default_vtab_args: ${msg}`, StatusCode.ERROR);
		}
	}

	getDefaultVtabModule(): { name: string; args: string[] } {
		return {
			name: this.defaultVtabModuleName,
			args: [...this.defaultVtabModuleArgs],
		};
	}
	// ----------------------------------------

	/**
	 * Registers a user-defined collation sequence.
	 * @param name The name of the collation sequence (case-insensitive).
	 * @param func The comparison function (a, b) => number (-1, 0, 1).
	 * @example
	 * // Example: Create a custom collation for phone numbers
	 * db.registerCollation('PHONENUMBER', (a, b) => {
	 *   // Normalize phone numbers by removing non-digit characters
	 *   const normalize = (phone) => phone.replace(/\D/g, '');
	 *   const numA = normalize(a);
	 *   const numB = normalize(b);
	 *   return numA < numB ? -1 : numA > numB ? 1 : 0;
	 * });
	 *
	 * // Then use it in SQL:
	 * // SELECT * FROM contacts ORDER BY phone COLLATE PHONENUMBER;
	 */
	registerCollation(name: string, func: CollationFunction): void {
		if (!this.isOpen) {
			throw new SqliteError("Database is closed", StatusCode.ERROR);
		}
		registerCollationUtil(name, func);
		console.log(`Registered collation: ${name}`);
	}

	/** @internal Gets a registered collation function */
	_getCollation(name: string): CollationFunction | undefined {
		return getCollationUtil(name);
	}

	/**
	 * Prepares, binds parameters, executes, and yields result rows for a query.
	 * This is a high-level convenience method for iterating over query results.
	 * The underlying statement is automatically finalized when iteration completes
	 * or if an error occurs.
	 *
	 * @param sql The SQL query string to execute.
	 * @param params Optional parameters to bind (array for positional, object for named).
	 * @yields Each result row as an object (`Record<string, SqlValue>`).
	 * @returns An `AsyncIterableIterator` yielding result rows.
	 * @throws MisuseError if the database is closed.
	 * @throws SqliteError on prepare/bind/execution errors.
	 *
	 * @example
	 * ```typescript
	 * try {
	 *   for await (const user of db.eval("SELECT * FROM users WHERE status = ?", ["active"])) {
	 *     console.log(`Active user: ${user.name}`);
	 *   }
	 * } catch (e) {
	 *   console.error("Query failed:", e);
	 * }
	 * ```
	 */
	async *eval(sql: string, params?: SqlValue[] | Record<string, SqlValue>): AsyncIterableIterator<Record<string, SqlValue>> {
		if (!this.isOpen) {
			throw new MisuseError("Database is closed");
		}

		let stmt: Statement | null = null;
		try {
			stmt = await this.prepare(sql);

			if (params) {
				stmt.bindAll(params);
			}

			let status: StatusCode;
			while ((status = await stmt.step()) === StatusCode.ROW) {
				yield stmt.getAsObject();
			}

			// Check if step() finished with an error
			if (status !== StatusCode.DONE && status !== StatusCode.OK) {
				throw new SqliteError(`Iteration failed for query: ${sql}`, status);
			}
			// Implicitly return { done: true } when loop finishes or step returns DONE/OK
		} finally {
			// Always finalize the internally prepared statement
			if (stmt) {
				await stmt.finalize();
			}
		}
	}
}
