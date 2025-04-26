import { VirtualTable } from '../table.js';
import { VirtualTableCursor } from '../cursor.js';
import type { VirtualTableModule, BaseModuleConfig } from '../module.js';
import type { IndexInfo } from '../indexInfo.js';
import { type SqlValue, StatusCode, SqlDataType } from '../../common/types.js';
import { SqliteError } from '../../common/errors.js';
import type { SqliteContext } from '../../func/context.js';
import type { Database } from '../../core/database.js';
import { safeJsonParse, evaluateJsonPathBasic, getJsonType } from '../../func/builtins/json-helpers.js';
import type { TableSchema } from '../../schema/table.js';
import { createDefaultColumnSchema } from '../../schema/column.js';
import { buildColumnIndexMap } from '../../schema/table.js';
import type { IndexConstraint } from '../indexInfo.js';

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
			checkConstraints: [],
			columns: JSON_EACH_COLUMNS,
			columnIndexMap: JSON_EACH_COLUMN_MAP,
			primaryKeyDefinition: [], // No explicit PK
			vtabModule: module,
			vtabInstance: this,
			vtabModuleName: 'json_each',
			isWithoutRowid: false,
			isStrict: false,
			isView: false,
		});
	}

	// --- Implement methods from VirtualTable --- //

	async xOpen(): Promise<VirtualTableCursor<this, any>> {
		// Simply instantiate the cursor
		return new JsonEachCursor(this) as unknown as VirtualTableCursor<this, any>;
	}

	xBestIndex(indexInfo: IndexInfo): number {
		// json_each doesn't really use indexes. It just iterates.
		// We could potentially check if a root path argument was provided via constraints,
		// but the filter logic already handles the root path from the table instance.
		indexInfo.estimatedCost = 100000; // Arbitrary large cost
		indexInfo.idxNum = 0; // Plan 0: Full iteration
		indexInfo.idxStr = null;
		indexInfo.orderByConsumed = false; // Output order is not guaranteed
		// Indicate no constraints are used by the plan itself
		indexInfo.aConstraintUsage = Array.from({ length: indexInfo.nConstraint }, () => ({ argvIndex: 0, omit: false }));
		return StatusCode.OK;
	}

	// Read-only methods remain
	async xUpdate(): Promise<{ rowid?: bigint }> {
		throw new SqliteError("json_each table is read-only", StatusCode.READONLY);
	}

	async xBegin() { return Promise.resolve(); } // No-op is fine
	async xSync() { return Promise.resolve(); } // No-op is fine
	async xCommit() { return Promise.resolve(); } // No-op is fine
	async xRollback() { return Promise.resolve(); } // No-op is fine
	async xRename() { throw new SqliteError("Cannot rename json_each table", StatusCode.ERROR); }

	// Disconnect/Destroy are no-ops for this ephemeral table
	async xDisconnect(): Promise<void> { /* No-op */ }
	async xDestroy(): Promise<void> { /* No-op */ }

	// ----------------------------------------- //
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

class JsonEachCursor extends VirtualTableCursor<JsonEachTable, JsonEachCursor> {
	private stack: IterationState[] = [];
	private currentRow: Record<string, SqlValue> | null = null;
	private elementIdCounter: number = 0;

	constructor(table: JsonEachTable) {
		super(table);
		this._isEof = true; // Start as EOF
	}

	/** Resets the cursor state. */
	reset(): void {
		this.stack = [];
		this.currentRow = null;
		this._isEof = true;
		this.elementIdCounter = 0;
	}

	/** Internal: Starts the iteration process for filter(). */
	private startIteration(startNode: any, rootPath: string | null): void {
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
			this._isEof = false;
			this.advanceToNextRow(); // Position on the first element
		} else {
			this._isEof = true;
		}
	}

	/** Internal: Advances the iterator stack and sets currentRow. */
	private advanceToNextRow(): void {
		if (this.stack.length === 0) {
			this._isEof = true;
			this.currentRow = null;
			return;
		}

		const currentState = this.stack[this.stack.length - 1];
		const currentValue = currentState.value;

		// Determine the key/index for the *current* node based on parent state
		const key = currentState.parentKey;
		const id = this.elementIdCounter++; // Generate ID for the current element
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
			_originalValue: currentValue, // Store original for potential stringification later
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
					parentId: id, // Use the ID generated for the current row
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
					parentId: id, // Use the ID generated for the current row
					currentIndex: -1,
				});
			}
		}

		// Check if stack became empty after popping and pushing children
		if (this.stack.length === 0) {
			// This means the row we just set in `this.currentRow` was the absolute last one.
			// The *next* call to `next()` will correctly set EOF.
		}
		this._isEof = false; // We successfully advanced to a row
	}

	// --- Implement Abstract Methods --- //

	async filter(idxNum: number, idxStr: string | null, constraints: ReadonlyArray<{ constraint: IndexConstraint, argvIndex: number }>, args: ReadonlyArray<SqlValue>): Promise<void> {
		const rootPath = this.table.rootPath;
		let startNode = this.table.parsedJson;

		// Apply root path if provided
		if (rootPath) {
			startNode = evaluateJsonPathBasic(startNode, rootPath);
		}

		this.startIteration(startNode, rootPath);
	}

	async next(): Promise<void> {
		if (this._isEof) return; // Don't advance if already EOF
		this.advanceToNextRow();
	}

	column(context: SqliteContext, index: number): number {
		if (!this.currentRow) {
			context.resultNull(); // Should not happen if VDBE checks eof()
			return StatusCode.OK;
		}
		const colName = JSON_EACH_COLUMNS[index]?.name;

		// Handle value formatting specifically for column requests
		if (colName === 'value') {
			const type = this.currentRow['type'];
			if (type === 'object' || type === 'array') {
				// Use the stored original value for stringification
				const originalValue = (this.currentRow as any)._originalValue;
				context.resultValue(originalValue !== undefined ? JSON.stringify(originalValue) : null);
			} else {
				context.resultValue(this.currentRow[colName] ?? null);
			}
		} else {
			context.resultValue(this.currentRow[colName] ?? null);
		}
		return StatusCode.OK;
	}

	async rowid(): Promise<bigint> {
		if (!this.currentRow) {
			throw new SqliteError("Cursor is not pointing to a valid row", StatusCode.MISUSE);
		}
		const id = this.currentRow['id'];
		if (typeof id === 'number') {
			return BigInt(id);
		}
		// Should have an ID if currentRow is set
		throw new SqliteError("Cannot get rowid for json_each cursor (missing ID)", StatusCode.INTERNAL);
	}

	async close(): Promise<void> {
		this.reset(); // Clear stack and state
	}

	// seekRelative/seekToRowid not supported, rely on base class default exception
}

// --- Module Implementation --- //

export class JsonEachModule implements VirtualTableModule<JsonEachTable, JsonEachCursor, JsonConfig> {
	xConnect(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string, options: JsonConfig): JsonEachTable {
		// For TVFs like json_each, xConnect essentially creates the instance based on runtime arguments
		const table = new JsonEachTable(db, this, schemaName, tableName, options.jsonSource, options.rootPath);
		return table;
	}

	// xCreate is same as xConnect for ephemeral table functions like this
	xCreate(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string, options: JsonConfig): JsonEachTable {
		return this.xConnect(db, pAux, moduleName, schemaName, tableName, options);
	}

	// Add missing xBestIndex implementation to the module
	xBestIndex(db: Database, tableInfo: TableSchema, indexInfo: IndexInfo): number {
		// json_each doesn't really use indexes. It just iterates.
		indexInfo.estimatedCost = 100000; // Arbitrary large cost
		indexInfo.idxNum = 0; // Plan 0: Full iteration
		indexInfo.idxStr = null;
		indexInfo.orderByConsumed = false; // Output order is not guaranteed
		// Indicate no constraints are used by the plan itself
		indexInfo.aConstraintUsage = Array.from({ length: indexInfo.nConstraint }, () => ({ argvIndex: 0, omit: false }));
		return StatusCode.OK;
	}

	// Add missing xDestroy implementation to the module (no-op)
	async xDestroy(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string): Promise<void> {
		// json_each is ephemeral, no persistent state to destroy at the module level
		return Promise.resolve();
	}
}
