import type { TableSchema } from './table.js';
import type { FunctionSchema } from './function.js';
import { getFunctionKey } from './function.js';
import { SqlDataType } from '../common/types.js';
import type { ViewSchema } from './view.js';
import { SqliteError } from '../common/errors.js';

/**
 * Determines the affinity of a column based on its declared type name.
 * Follows SQLite affinity rules: https://www.sqlite.org/datatype3.html#type_affinity
 *
 * @param typeName The declared type name (case-insensitive)
 * @returns The determined affinity
 */
export function getAffinityForType(typeName: string | undefined | null): SqlDataType {
	if (!typeName) {
		return SqlDataType.BLOB;
	}
	const type = typeName.toUpperCase();

	if (type.includes('INT')) {
		return SqlDataType.INTEGER;
	}
	if (type.includes('TEXT') || type.includes('CHAR') || type.includes('CLOB')) {
		return SqlDataType.TEXT;
	}
	if (type.includes('BLOB')) {
		return SqlDataType.BLOB;
	}
	if (type.includes('REAL') || type.includes('FLOA') || type.includes('DOUB')) {
		return SqlDataType.REAL;
	}
	return SqlDataType.NUMERIC;
}

/**
 * Represents a single database schema (e.g., "main", "temp").
 * Contains collections of tables, functions, etc. defined within that schema.
 */
export class Schema {
	public readonly name: string;
	private tables: Map<string, TableSchema> = new Map();
	private functions: Map<string, FunctionSchema> = new Map();
	private views: Map<string, ViewSchema> = new Map();

	/**
	 * Creates a new schema instance
	 *
	 * @param name The schema name (e.g. "main", "temp")
	 */
	constructor(name: string) {
		this.name = name;
	}

	/**
	 * Adds or replaces a table definition in the schema
	 *
	 * @param table The table schema to add
	 * @throws Error if table's schema name doesn't match or a view with same name exists
	 */
	addTable(table: TableSchema): void {
		if (table.schemaName !== this.name) {
			throw new Error(`Table ${table.name} has wrong schema name ${table.schemaName}, expected ${this.name}`);
		}
		if (this.views.has(table.name.toLowerCase())) {
			throw new SqliteError(`Schema '${this.name}': Cannot add table '${table.name}', a view with the same name already exists.`);
		}
		this.tables.set(table.name.toLowerCase(), table);
		console.log(`Schema '${this.name}': Added/Updated table '${table.name}'`);
	}

	/**
	 * Gets a table definition by name (case-insensitive)
	 *
	 * @param tableName The table name to look up
	 * @returns The table schema or undefined if not found
	 */
	getTable(tableName: string): TableSchema | undefined {
		return this.tables.get(tableName.toLowerCase());
	}

	/**
	 * Returns an iterator over all tables in the schema
	 *
	 * @returns Iterator of table schemas
	 */
	getAllTables(): IterableIterator<TableSchema> {
		return this.tables.values();
	}

	/**
	 * Removes a table definition from the schema
	 *
	 * @param tableName The name of the table to remove
	 * @returns true if found and removed, false otherwise
	 */
	removeTable(tableName: string): boolean {
		const key = tableName.toLowerCase();
		const exists = this.tables.has(key);
		if (exists) {
			console.log(`Schema '${this.name}': Removed table '${tableName}'`);
			this.tables.delete(key);
		}
		return exists;
	}

	/**
	 * Clears all tables (does not call VTable disconnect/destroy)
	 */
	clearTables(): void {
		this.tables.clear();
	}

	/**
	 * Adds or replaces a view definition in the schema
	 *
	 * @param view The view schema to add
	 * @throws Error if view's schema name doesn't match or a table with same name exists
	 */
	addView(view: ViewSchema): void {
		if (view.schemaName !== this.name) {
			throw new Error(`View ${view.name} has wrong schema name ${view.schemaName}, expected ${this.name}`);
		}
		if (this.tables.has(view.name.toLowerCase())) {
			throw new SqliteError(`Schema '${this.name}': Cannot add view '${view.name}', a table with the same name already exists.`);
		}
		this.views.set(view.name.toLowerCase(), view);
		console.log(`Schema '${this.name}': Added/Updated view '${view.name}'`);
	}

	/**
	 * Gets a view definition by name (case-insensitive)
	 *
	 * @param viewName The view name to look up
	 * @returns The view schema or undefined if not found
	 */
	getView(viewName: string): ViewSchema | undefined {
		return this.views.get(viewName.toLowerCase());
	}

	/**
	 * Returns an iterator over all views in the schema
	 *
	 * @returns Iterator of view schemas
	 */
	getAllViews(): IterableIterator<ViewSchema> {
		return this.views.values();
	}

	/**
	 * Removes a view definition from the schema
	 *
	 * @param viewName The name of the view to remove
	 * @returns true if found and removed, false otherwise
	 */
	removeView(viewName: string): boolean {
		const key = viewName.toLowerCase();
		const exists = this.views.has(key);
		if (exists) {
			console.log(`Schema '${this.name}': Removed view '${viewName}'`);
			this.views.delete(key);
		}
		return exists;
	}

	/**
	 * Clears all views
	 */
	clearViews(): void {
		this.views.clear();
	}

	/**
	 * Adds or replaces a function definition in the schema
	 * Calls the destructor for any existing function being replaced
	 *
	 * @param func The function schema to add
	 */
	addFunction(func: FunctionSchema): void {
		const key = getFunctionKey(func.name, func.numArgs);
		const existing = this.functions.get(key);
		if (existing?.xDestroy && existing.userData !== func.userData) {
			try { existing.xDestroy(existing.userData); } catch (e) { console.error(`Destructor failed for function ${key}`, e); }
		}
		this.functions.set(key, func);
		console.log(`Schema '${this.name}': Added/Updated function '${func.name}/${func.numArgs}'`);
	}

	/**
	 * Gets a function definition by name and argument count (case-insensitive name)
	 * First checks for exact argument count match, then tries variable args (-1)
	 *
	 * @param name The function name
	 * @param numArgs The number of arguments
	 * @returns The function schema or undefined if not found
	 */
	getFunction(name: string, numArgs: number): FunctionSchema | undefined {
		const key = getFunctionKey(name, numArgs);
		const varArgsKey = getFunctionKey(name, -1);
		return this.functions.get(key) ?? this.functions.get(varArgsKey);
	}

	/**
	 * @internal Returns iterator over managed functions
	 */
	_getAllFunctions(): IterableIterator<FunctionSchema> {
		return this.functions.values();
	}

	/**
	 * Removes a function definition, calling its destructor if needed
	 *
	 * @param name The function name
	 * @param numArgs The number of arguments
	 * @returns true if found and removed, false otherwise
	 */
	removeFunction(name: string, numArgs: number): boolean {
		const key = getFunctionKey(name, numArgs);
		const func = this.functions.get(key);
		if (func) {
			if (func.xDestroy && func.userData) {
				try { func.xDestroy(func.userData); } catch (e) { console.error(`Destructor failed for function ${key}`, e); }
			}
			console.log(`Schema '${this.name}': Removed function '${name}/${numArgs}'`);
			return this.functions.delete(key);
		}
		return false;
	}

	/**
	 * Clears all functions, calling destructors if needed
	 */
	clearFunctions(): void {
		this.functions.forEach(func => {
			if (func.xDestroy && func.userData) {
				try { func.xDestroy(func.userData); } catch (e) { console.error(`Destructor failed for function ${func.name}/${func.numArgs}`, e); }
			}
		});
		this.functions.clear();
	}

	// TODO: Add methods for triggers, views, indexes if they become necessary later.
}
