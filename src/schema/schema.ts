import type { TableSchema } from './table';
import type { FunctionSchema } from './function';
import { getFunctionKey } from './function';
import { SqlDataType } from '../common/types'; // Import SqlDataType

/**
 * Determines the affinity of a column based on its declared type name.
 * Follows SQLite affinity rules: https://www.sqlite.org/datatype3.html#type_affinity
 * @param typeName The declared type name (case-insensitive).
 * @returns The determined affinity.
 */
export function getAffinityForType(typeName: string | undefined | null): SqlDataType {
	if (!typeName) {
		return SqlDataType.BLOB; // Or NONE? Defaulting to BLOB (no affinity)
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
	// Default affinity
	return SqlDataType.NUMERIC;
}

/**
 * Represents a single database schema (e.g., "main", "temp").
 * Contains collections of tables, functions, etc. defined within that schema.
 */
export class Schema {
	public readonly name: string;
	private tables: Map<string, TableSchema> = new Map();
	private functions: Map<string, FunctionSchema> = new Map(); // Key uses getFunctionKey()

	constructor(name: string) {
		this.name = name;
	}

	/** Adds or replaces a table definition in the schema. */
	addTable(table: TableSchema): void {
		if (table.schemaName !== this.name) {
			throw new Error(`Table ${table.name} has wrong schema name ${table.schemaName}, expected ${this.name}`);
		}
		this.tables.set(table.name.toLowerCase(), table);
		console.log(`Schema '${this.name}': Added/Updated table '${table.name}'`);
	}

	/** Gets a table definition by name (case-insensitive). */
	getTable(tableName: string): TableSchema | undefined {
		return this.tables.get(tableName.toLowerCase());
	}

	/** Returns an iterator over all tables in the schema. */
	getAllTables(): IterableIterator<TableSchema> {
		return this.tables.values();
	}

	/** Removes a table definition from the schema. Returns true if found and removed. */
	removeTable(tableName: string): boolean {
		const key = tableName.toLowerCase();
		const exists = this.tables.has(key);
		if (exists) {
			console.log(`Schema '${this.name}': Removed table '${tableName}'`);
			this.tables.delete(key);
		}
		return exists;
	}


	/** Adds or replaces a function definition in the schema. */
	addFunction(func: FunctionSchema): void {
		const key = getFunctionKey(func.name, func.numArgs);
		const existing = this.functions.get(key);
		// Call destructor for existing function's user data if replaced
		if (existing?.xDestroy && existing.userData !== func.userData) {
			try { existing.xDestroy(existing.userData); } catch (e) { console.error(`Destructor failed for function ${key}`, e); }
		}
		this.functions.set(key, func);
		console.log(`Schema '${this.name}': Added/Updated function '${func.name}/${func.numArgs}'`);
	}

	/** Gets a function definition by name and argument count (case-insensitive name). */
	getFunction(name: string, numArgs: number): FunctionSchema | undefined {
		// Check specific arity first, then varargs (-1)
		const key = getFunctionKey(name, numArgs);
		const varArgsKey = getFunctionKey(name, -1);
		return this.functions.get(key) ?? this.functions.get(varArgsKey);
	}

	/** @internal Returns iterator over managed functions */
	_getAllFunctions(): IterableIterator<FunctionSchema> {
		return this.functions.values();
	}

	/** Removes a function definition. Returns true if found and removed. */
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

	/** Clears all functions, calling destructors if needed. */
	clearFunctions(): void {
		this.functions.forEach(func => {
			if (func.xDestroy && func.userData) {
				try { func.xDestroy(func.userData); } catch (e) { console.error(`Destructor failed for function ${func.name}/${func.numArgs}`, e); }
			}
		});
		this.functions.clear();
	}

	/** Clears all tables (does not call VTable disconnect/destroy). */
	clearTables(): void {
		this.tables.clear();
	}

	// TODO: Add methods for triggers, views, indexes if they become necessary later.
}
