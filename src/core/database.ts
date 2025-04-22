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
import { MemoryTableModule } from '../vtab/memory-table';
import { JsonEachModule } from '../vtab/json-each';
import { JsonTreeModule } from '../vtab/json-tree'; // Import JsonTreeModule

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
			// Initialize it
			// await stmt._prepare(); // Removed - Compilation happens lazily

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
		this.schemaManager.clearAll(true);

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
		if (!this.isOpen) throw new MisuseError("Database is closed");

		const output: JsonDatabaseSchema = {
			schemaVersion: 1,
			schemas: {},
		};

		for (const schema of this.schemaManager._getAllSchemas()) {
			const jsonSchema: JsonSchema = {
				tables: [],
				functions: [],
			};

			for (const tableSchema of schema.getAllTables()) {
				const jsonTable: JsonTableSchema = {
					name: tableSchema.name,
					columns: tableSchema.columns.map((col: ColumnSchema) => {
						const affinityKey = SqlDataType[col.affinity] as keyof typeof SqlDataType;
						let jsonDefault: string | number | null = null;
						if (typeof col.defaultValue === 'string' || typeof col.defaultValue === 'number' || col.defaultValue === null) {
							jsonDefault = col.defaultValue;
						} else if (typeof col.defaultValue === 'bigint') {
							jsonDefault = col.defaultValue.toString() + 'n';
						} else if (col.defaultValue instanceof Uint8Array) {
							const hex = Array.from(col.defaultValue).map(b => b.toString(16).padStart(2, '0')).join('');
							jsonDefault = `x'${hex}'`;
						}

						return {
							name: col.name,
							affinity: affinityKey,
							notNull: col.notNull,
							primaryKey: col.primaryKey,
							defaultValue: jsonDefault,
							collation: col.collation,
							hidden: col.hidden,
							generated: col.generated,
						} as JsonColumnSchema;
					}),
					primaryKeyDefinition: [...tableSchema.primaryKeyDefinition],
					isVirtual: tableSchema.isVirtual,
					vtabModule: tableSchema.vtabModuleName,
					vtabArgs: tableSchema.vtabArgs ? [...tableSchema.vtabArgs] : undefined,
				};
				jsonSchema.tables.push(jsonTable);
			}

			for (const funcSchema of schema._getAllFunctions()) {
				const jsonFunc: JsonFunctionSchema = {
					name: funcSchema.name,
					numArgs: funcSchema.numArgs,
					flags: funcSchema.flags,
				};
				jsonSchema.functions.push(jsonFunc);
			}

			output.schemas[schema.name] = jsonSchema;
		}

		return JSON.stringify(output, null, 2);
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
		if (!this.isOpen) throw new MisuseError("Database is closed");
		if (this.inTransaction) throw new MisuseError("Cannot import schema during a transaction");

		let jsonData: JsonDatabaseSchema;
		try {
			jsonData = JSON.parse(jsonString);
		} catch (e: any) {
			throw new Error(`Failed to parse JSON schema: ${e.message}`);
		}

		if (jsonData.schemaVersion !== 1) {
			throw new Error(`Unsupported schema version: ${jsonData.schemaVersion}. Expected version 1.`);
		}

		// Clear existing user-defined schemas before import
		// Keep 'main' and 'temp' but clear their contents?
		// Let's clear tables/functions from main/temp for now.
		this.schemaManager.clearAll(false); // Don't disconnect VTabs yet

		for (const schemaName in jsonData.schemas) {
			if (!Object.prototype.hasOwnProperty.call(jsonData.schemas, schemaName)) continue;

			let schema = this.schemaManager.getSchema(schemaName);
			if (!schema) {
				if (schemaName === 'main' || schemaName === 'temp') {
					console.error(`Core schema ${schemaName} missing during import!`);
					throw new SqliteError(`Internal error: Core schema ${schemaName} is missing.`, StatusCode.INTERNAL);
				} else {
					schema = this.schemaManager.addSchema(schemaName);
				}
			} else {
				// Clear existing contents of main/temp if they weren't cleared by clearAll
				schema.clearTables();
				schema.clearFunctions();
			}

			const jsonSchema = jsonData.schemas[schemaName];

			// Import Tables
			for (const jsonTable of jsonSchema.tables) {
				const columns: ColumnSchema[] = jsonTable.columns.map(jsonCol => {
					const affinity = SqlDataType[jsonCol.affinity as keyof typeof SqlDataType];
					if (affinity === undefined) {
						throw new Error(`Invalid affinity string "${jsonCol.affinity}" for column ${jsonCol.name}`);
					}
					// Deserialize default value
					let defaultValue: SqlValue = null;
					if (typeof jsonCol.defaultValue === 'string') {
						if (jsonCol.defaultValue.endsWith('n')) {
							try { defaultValue = BigInt(jsonCol.defaultValue.slice(0, -1)); } catch { /* ignore invalid */ }
						} else if (jsonCol.defaultValue.toLowerCase().startsWith('x\'') && jsonCol.defaultValue.endsWith('\'')) {
							const hex = jsonCol.defaultValue.slice(2, -1);
							try {
								const bytes = new Uint8Array(hex.length / 2);
								for (let i = 0; i < hex.length; i += 2) {
									bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
								}
								defaultValue = bytes;
							} catch { /* ignore invalid hex */ }
						} else {
							defaultValue = jsonCol.defaultValue; // Assume string literal
						}
					} else if (typeof jsonCol.defaultValue === 'number' || jsonCol.defaultValue === null) {
						defaultValue = jsonCol.defaultValue;
					}

					return {
						name: jsonCol.name,
						affinity: affinity,
						notNull: jsonCol.notNull,
						primaryKey: jsonCol.primaryKey,
						pkOrder: jsonTable.primaryKeyDefinition.find(pk => pk.index === jsonTable.columns.indexOf(jsonCol)) ? jsonTable.primaryKeyDefinition.findIndex(pk => pk.index === jsonTable.columns.indexOf(jsonCol)) + 1 : 0,
						defaultValue: defaultValue,
						collation: jsonCol.collation,
						hidden: jsonCol.hidden,
						generated: jsonCol.generated,
					} as ColumnSchema;
				});

				const tableSchema: TableSchema = {
					name: jsonTable.name,
					schemaName: schemaName,
					columns: Object.freeze(columns),
					columnIndexMap: Object.freeze(buildColumnIndexMap(columns)),
					primaryKeyDefinition: Object.freeze(jsonTable.primaryKeyDefinition),
					isVirtual: jsonTable.isVirtual,
					vtabModuleName: jsonTable.vtabModule,
					vtabArgs: jsonTable.vtabArgs ? Object.freeze(jsonTable.vtabArgs) : undefined,
					// vtabModule, vtabInstance, vtabAuxData will be populated on connect
				};
				schema.addTable(tableSchema);
			}

			// Import Functions (stubs only)
			for (const jsonFunc of jsonSchema.functions) {
				// Check if it's a built-in function and skip if so?
				// Or just allow overriding? Let's allow overriding for now.
				const funcSchema: FunctionSchema = {
					name: jsonFunc.name,
					numArgs: jsonFunc.numArgs,
					flags: jsonFunc.flags,
					// Implementations (xFunc, xStep, xFinal) are NOT restored
				};
				schema.addFunction(funcSchema);
			}
		}
		// TODO: Warn only if needed functions and modules are missing
		console.warn("Schema imported from JSON. Function implementations and VTab connections must be re-established manually.");
	}
}
