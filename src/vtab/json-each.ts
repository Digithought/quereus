import { VirtualTable } from './table';
import { VirtualTableCursor } from './cursor';
import type { VirtualTableModule, BaseModuleConfig } from './module';
import type { IndexInfo } from './indexInfo';
import { type SqlValue, StatusCode, SqlDataType } from '../common/types';
import { SqliteError } from '../common/errors';
import type { SqliteContext } from '../func/context';
import type { Database } from '../core/database';
import { safeJsonParse, evaluateJsonPathBasic, getJsonType } from '../func/builtins/json-helpers';
import type { TableSchema } from '../schema/table';
import { createDefaultColumnSchema } from '../schema/column';
import { buildColumnIndexMap } from '../schema/table';

// --- Define Configuration Interface ---
interface JsonConfig extends BaseModuleConfig {
	jsonSource: SqlValue;
	runtimeArgs?: ReadonlyArray<SqlValue>; // For future use if needed
	rootPath?: SqlValue;
}
// ------------------------------------

// --- Constants for json_each Schema ---
const JSON_EACH_SCHEMA: ReadonlyArray<{ name: string, affinity: SqlDataType }> = Object.freeze([
	{ name: 'key', affinity: SqlDataType.INTEGER | SqlDataType.TEXT }, // INTEGER for array index, TEXT for object key
	{ name: 'value', affinity: SqlDataType.TEXT }, // Can be any JSON value, TEXT is safest representation
	{ name: 'type', affinity: SqlDataType.TEXT }, // 'object', 'array', 'string', 'integer', 'real', 'true', 'false', 'null'
	{ name: 'atom', affinity: SqlDataType.TEXT }, // Fix 1: Use TEXT affinity for atoms
	{ name: 'id', affinity: SqlDataType.INTEGER }, // Unique integer ID for each element
	{ name: 'parent', affinity: SqlDataType.INTEGER }, // ID of the parent element (0 for root elements)
	{ name: 'fullkey', affinity: SqlDataType.TEXT }, // Full path to the element
	{ name: 'path', affinity: SqlDataType.TEXT }, // Path relative to the starting point
]);

const JSON_EACH_COLUMNS = Object.freeze(
	JSON_EACH_SCHEMA.map(col => ({
		...createDefaultColumnSchema(col.name),
		affinity: col.affinity,
	}))
);
const JSON_EACH_COLUMN_MAP = Object.freeze(buildColumnIndexMap(JSON_EACH_COLUMNS));

// --- Table Instance --- //

class JsonEachTable extends VirtualTable {
	public readonly parsedJson: any;
	public readonly rootPath: string | null;
	public readonly tableSchema: TableSchema;

	constructor(
		db: Database,
		module: VirtualTableModule<any, any>,
		schemaName: string,
		tableName: string,
		jsonText: SqlValue,
		rootPath?: SqlValue
	) {
		super(db, module, schemaName, tableName);
		this.parsedJson = safeJsonParse(jsonText);
		this.rootPath = (typeof rootPath === 'string' && rootPath) ? rootPath : null;

		if (this.parsedJson === null && typeof jsonText === 'string') {
			throw new SqliteError(`Invalid JSON provided to ${tableName}`, StatusCode.ERROR);
		}

		// Define the fixed schema for this instance
		this.tableSchema = Object.freeze({
			name: tableName,
			schemaName: schemaName,
			columns: JSON_EACH_COLUMNS,
			columnIndexMap: JSON_EACH_COLUMN_MAP,
			primaryKeyDefinition: [], // No explicit PK
			isVirtual: true,
			vtabModule: module,
			vtabInstance: this,
			vtabModuleName: 'json_each',
		});
	}
}

// --- Cursor Instance --- //

interface IterationState {
	value: any;
	parentPath: string;
	parentKey: string | number | null;
	parentId: number;
	currentIndex: number; // Index if iterating an array
	keys?: string[]; // Keys if iterating an object
}

class JsonEachCursor extends VirtualTableCursor<JsonEachTable> {
	private stack: IterationState[] = [];
	private currentRow: Record<string, SqlValue> | null = null;
	private isEof: boolean = true;
	private elementIdCounter: number = 0;

	constructor(table: JsonEachTable) {
		super(table);
	}

	// Methods for xFilter, xNext, xEof, xColumn will go here
	// They will manage the stack and currentRow

	reset(): void {
		this.stack = [];
		this.currentRow = null;
		this.isEof = true;
		this.elementIdCounter = 0;
	}

	startIteration(startNode: any, rootPath: string | null): void {
		this.reset();
		const initialPath = rootPath ?? '$';
		if (startNode !== undefined) {
			// Push the root node to start
			this.stack.push({
				value: startNode,
				parentPath: '', // Root has no parent path segment
				parentKey: null, // Root has no key/index relative to parent
				parentId: 0,
				currentIndex: -1, // Indicates not currently iterating array/object keys
			});
			this.isEof = false;
			this.next(); // Move to the first element (the root itself)
		} else {
			this.isEof = true;
		}
	}

	next(): void {
		if (this.stack.length === 0) {
			this.isEof = true;
			this.currentRow = null;
			return;
		}

		const currentState = this.stack[this.stack.length - 1];
		const currentValue = currentState.value;

		// Determine the key/index for the *current* node based on parent state
		const key = currentState.parentKey;
		const id = this.elementIdCounter++;
		const path = currentState.parentPath;
		const fullkey = key !== null ? `${path}${typeof key === 'number' ? `[${key}]` : `.${key}`}` : path;
		const type = getJsonType(currentValue);
		const atom = (type === 'object' || type === 'array') ? null : currentValue;

		this.currentRow = {
			key: key,
			value: (type === 'object' || type === 'array') ? JSON.stringify(currentValue) : currentValue,
			type: type,
			atom: atom,
			id: id,
			parent: currentState.parentId,
			fullkey: fullkey,
			path: path,
		};

		// Pop the current state as it's now processed (yielded)
		this.stack.pop();

		// If the current node is an array or object, push its children (in reverse order for stack processing)
		if (Array.isArray(currentValue)) {
			for (let i = currentValue.length - 1; i >= 0; i--) {
				this.stack.push({
					value: currentValue[i],
					parentPath: fullkey, // Path to this array
					parentKey: i,
					parentId: id,
					currentIndex: -1, // Reset for the child
				});
			}
		} else if (typeof currentValue === 'object' && currentValue !== null) {
			const keys = Object.keys(currentValue).sort().reverse(); // Process keys in reverse for stack
			for (const objKey of keys) {
				this.stack.push({
					value: currentValue[objKey],
					parentPath: fullkey, // Path to this object
					parentKey: objKey,
					parentId: id,
					currentIndex: -1,
				});
			}
		}

		// Check if stack is now empty
		if (this.stack.length === 0) {
			// We just processed the last item, but EOF isn't reached until the *next* call to next()
			// So, don't set isEof here. The check at the beginning of next() will handle it.
		}
	}

	eof(): boolean {
		return this.isEof;
	}

	column(index: number): SqlValue {
		if (!this.currentRow) return null;
		const colName = JSON_EACH_COLUMNS[index]?.name;
		// Handle value formatting specifically for column requests
		if (colName === 'value' && this.currentRow) {
			const type = this.currentRow['type'];
			// Return primitives directly, format objects/arrays as JSON text
			if (type === 'object' || type === 'array') {
				// We need the original JS value to stringify
				// How to get it? currentRow stores stringified version.
				// Solution: Store original value in cursor state? Or re-evaluate path?
				// Let's try storing original value briefly.
				const originalValue = (this.currentRow as any)._originalValue; // Need to add this
				return originalValue ? JSON.stringify(originalValue) : null;
			} else {
				return this.currentRow[colName] ?? null;
			}
		} else {
			return this.currentRow[colName] ?? null;
		}
	}
}

// --- Module Implementation --- //

export class JsonEachModule implements VirtualTableModule<JsonEachTable, JsonEachCursor, JsonConfig> {
	xConnect(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string, options: JsonConfig): JsonEachTable {
		// Args should be: module_name, schema_name, table_name, json_text, [root_path]
		/* // Old argument parsing
		if (args.length < 4 || args.length > 5) {
			throw new SqliteError(`json_each requires 1 or 2 arguments (json, [path])`, StatusCode.ERROR);
		}
		const schemaName = args[1];
		const tableName = args[2];
		const jsonText = args[3];
		const rootPath = args.length > 4 ? args[4] : undefined;
		*/

		const table = new JsonEachTable(db, this, schemaName, tableName, options.jsonSource, options.rootPath);
		// Fix 3: Remove declareVtab - instantiation happens differently for table functions
		// No need to declare vtab here, connection implies existence for TVFs

		return table;
	}

	// xCreate is same as xConnect for ephemeral table functions like this
	// xCreate = this.xConnect;
	xCreate(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string, options: JsonConfig): JsonEachTable {
		return this.xConnect(db, pAux, moduleName, schemaName, tableName, options);
	}

	async xDisconnect(table: JsonEachTable): Promise<void> { /* No-op */ }
	async xDestroy(table: JsonEachTable): Promise<void> { /* No-op */ }

	async xOpen(table: JsonEachTable): Promise<JsonEachCursor> {
		return new JsonEachCursor(table);
	}

	async xClose(cursor: JsonEachCursor): Promise<void> {
		cursor.reset();
	}

	xBestIndex(table: JsonEachTable, indexInfo: IndexInfo): number {
		// json_each doesn't really use indexes. It just iterates.
		// We can check if a root path argument was provided via constraints.
		indexInfo.estimatedCost = 100000; // Arbitrary large cost
		indexInfo.idxNum = 0; // Plan 0: Full iteration
		indexInfo.idxStr = null;
		indexInfo.orderByConsumed = false; // Output order is not guaranteed
		return StatusCode.OK;
	}

	async xFilter(cursor: JsonEachCursor, idxNum: number, idxStr: string | null, args: ReadonlyArray<SqlValue>): Promise<void> {
		const rootPath = cursor.table.rootPath;
		let startNode = cursor.table.parsedJson;

		// Apply root path if provided
		if (rootPath) {
			// Fix 4: Use imported evaluateJsonPathBasic
			startNode = evaluateJsonPathBasic(startNode, rootPath);
		}

		cursor.startIteration(startNode, rootPath);
	}

	async xNext(cursor: JsonEachCursor): Promise<void> {
		cursor.next();
	}

	async xEof(cursor: JsonEachCursor): Promise<boolean> {
		return cursor.eof();
	}

	xColumn(cursor: JsonEachCursor, context: SqliteContext, i: number): number {
		context.resultValue(cursor.column(i));
		return StatusCode.OK;
	}

	xRowid(cursor: JsonEachCursor): Promise<bigint> {
		// json_each rows don't have a stable rowid in SQLite sense
		// Use the internal element id?
		// Fix 5: Use public column() method to get id
		const idColIndex = JSON_EACH_COLUMN_MAP.get('id')!;
		const id = cursor.column(idColIndex);
		if (typeof id === 'number') {
			return Promise.resolve(BigInt(id));
		}
		return Promise.reject(new SqliteError("Cannot get rowid for json_each cursor", StatusCode.ERROR));
	}

	// Fix 6: Make read-only methods async and match return type signature
	async xUpdate(): Promise<{ rowid?: bigint }> {
		throw new SqliteError("json_each table is read-only", StatusCode.READONLY);
	}
	async xBegin() { return Promise.resolve(); } // No-op is fine
	async xSync() { return Promise.resolve(); } // No-op is fine
	async xCommit() { return Promise.resolve(); } // No-op is fine
	async xRollback() { return Promise.resolve(); } // No-op is fine
	async xRename() { throw new SqliteError("Cannot rename json_each table", StatusCode.ERROR); }
}
