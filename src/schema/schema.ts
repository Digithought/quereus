import type { TableSchema } from './table.js';
import type { FunctionSchema } from './function.js';
import { getFunctionKey } from './function.js';
import { SqlDataType } from '../common/types.js';
import type { ViewSchema } from './view.js';
import { SqliterError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import { createLogger } from '../common/logger.js';

const log = createLogger('schema:schema');
const errorLog = log.extend('error');

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
	 * Retrieves a table schema definition
	 *
	 * @param tableName The name of the table (case-insensitive)
	 * @returns The table schema or undefined if not found
	 */
	getTable(tableName: string): TableSchema | undefined {
		return this.tables.get(tableName.toLowerCase());
	}

	/**
	 * Adds or replaces a table definition in the schema
	 *
	 * @param table The table schema object
	 * @throws SqliteError if a view with the same name exists
	 */
	addTable(table: TableSchema): void {
		// Ensure no view conflict
		if (this.views.has(table.name.toLowerCase())) {
			throw new SqliterError(`Schema '${this.name}': Cannot add table '${table.name}', a view with the same name already exists.`);
		}
		this.tables.set(table.name.toLowerCase(), table);
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
			throw new SqliterError(`Schema '${this.name}': Cannot add view '${view.name}', a table with the same name already exists.`);
		}
		this.views.set(view.name.toLowerCase(), view);
		log(`Added/Updated view '%s' in schema '%s'`, view.name, this.name);
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
			log(`Removed view '%s' from schema '%s'`, viewName, this.name);
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
			try { existing.xDestroy(existing.userData); } catch (e) {
				errorLog(`Destructor failed for function %s in schema '%s': %O`, key, this.name, e);
			}
		}
		this.functions.set(key, func);
		log(`Added/Updated function '%s' in schema '%s'`, `${func.name}/${func.numArgs}`, this.name);
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
				try { func.xDestroy(func.userData); } catch (e) {
					errorLog(`Destructor failed for function %s in schema '%s': %O`, key, this.name, e);
				}
			}
			log(`Removed function '%s' from schema '%s'`, `${name}/${numArgs}`, this.name);
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
				try { func.xDestroy(func.userData); } catch (e) {
					errorLog(`Destructor failed for function %s in schema '%s': %O`, `${func.name}/${func.numArgs}`, this.name, e);
				}
			}
		});
		this.functions.clear();
	}
}
