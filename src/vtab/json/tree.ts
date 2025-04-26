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

// --- Define Configuration Interface (Shared with JsonEach) ---
interface JsonConfig extends BaseModuleConfig {
	jsonSource: SqlValue;
	runtimeArgs?: ReadonlyArray<SqlValue>;
	rootPath?: SqlValue;
}
// ----------------------------------------------------------

// --- Constants for json_tree Schema (Identical to json_each) ---
const JSON_TREE_SCHEMA: ReadonlyArray<{ name: string, affinity: SqlDataType }> = Object.freeze([
	{ name: 'key', affinity: SqlDataType.INTEGER | SqlDataType.TEXT },
	{ name: 'value', affinity: SqlDataType.TEXT },
	{ name: 'type', affinity: SqlDataType.TEXT },
	{ name: 'atom', affinity: SqlDataType.TEXT },
	{ name: 'id', affinity: SqlDataType.INTEGER },
	{ name: 'parent', affinity: SqlDataType.INTEGER },
	{ name: 'fullkey', affinity: SqlDataType.TEXT },
	{ name: 'path', affinity: SqlDataType.TEXT },
]);

const JSON_TREE_COLUMNS = Object.freeze(
	JSON_TREE_SCHEMA.map(col => ({
		...createDefaultColumnSchema(col.name),
		affinity: col.affinity,
	}))
);
const JSON_TREE_COLUMN_MAP = Object.freeze(buildColumnIndexMap(JSON_TREE_COLUMNS));

// --- Table Instance (Can potentially inherit if no differences needed) ---
// For now, keep separate to set correct vtabModuleName in schema
class JsonTreeTable extends VirtualTable {
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

		this.tableSchema = Object.freeze({
			name: tableName,
			schemaName: schemaName,
			checkConstraints: [],
			columns: JSON_TREE_COLUMNS,
			columnIndexMap: JSON_TREE_COLUMN_MAP,
			primaryKeyDefinition: [],
			vtabModule: module,
			vtabInstance: this,
			vtabModuleName: 'json_tree', // Correct module name
			isWithoutRowid: false,
			isStrict: false,
			isView: false,
		});
	}

	// --- Implement methods from VirtualTable --- //

	async xOpen(): Promise<VirtualTableCursor<this, any>> {
		return new JsonTreeCursor(this) as unknown as VirtualTableCursor<this, any>;
	}

	xBestIndex(indexInfo: IndexInfo): number {
		indexInfo.estimatedCost = 100000; // Arbitrary large cost
		indexInfo.idxNum = 0; // Plan 0: Full iteration
		indexInfo.idxStr = null;
		indexInfo.orderByConsumed = false; // Output order is depth-first
		// Indicate no constraints are used by the plan itself
		indexInfo.aConstraintUsage = Array.from({ length: indexInfo.nConstraint }, () => ({ argvIndex: 0, omit: false }));
		return StatusCode.OK;
	}

	async xUpdate(): Promise<{ rowid?: bigint }> {
		throw new SqliteError("json_tree table is read-only", StatusCode.READONLY);
	}
	async xBegin() { return Promise.resolve(); }
	async xSync() { return Promise.resolve(); }
	async xCommit() { return Promise.resolve(); }
	async xRollback() { return Promise.resolve(); }
	async xRename() { throw new SqliteError("Cannot rename json_tree table", StatusCode.ERROR); }

	// Disconnect/Destroy are no-ops for this ephemeral table
	async xDisconnect(): Promise<void> { /* No-op */ }
	async xDestroy(): Promise<void> { /* No-op */ }

	// ----------------------------------------- //
}

// --- Cursor Instance (Must be specific due to different iteration logic) --- //

interface IterationState {
	value: any;
	parentPath: string;
	parentKey: string | number | null;
	parentId: number;
	childrenPushed: boolean; // Flag to track if children have been added to stack
}

class JsonTreeCursor extends VirtualTableCursor<JsonTreeTable, JsonTreeCursor> {
	private stack: IterationState[] = [];
	private currentRow: Record<string, SqlValue> | null = null;
	private elementIdCounter: number = 0;

	constructor(table: JsonTreeTable) {
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
		if (startNode !== undefined) {
			this.stack.push({
				value: startNode,
				parentPath: '', // Root has no parent path
				parentKey: null, // Root has no key relative to parent
				parentId: 0,
				childrenPushed: false, // Start with children not pushed
			});
			this._isEof = false;
			this.advanceToNextRow(); // Immediately try to position on the first element
		} else {
			this._isEof = true;
		}
	}

	/** Internal: Advances the depth-first stack and sets currentRow. */
	private advanceToNextRow(): void {
		while (this.stack.length > 0) {
			const currentState = this.stack[this.stack.length - 1]; // Peek top
			const currentValue = currentState.value;
			const isContainer = typeof currentValue === 'object' && currentValue !== null;

			// If we haven't processed this node (yielded its row) yet...
			if (!this.currentRow || currentState !== (this.currentRow as any)._stateRef) {
				const key = currentState.parentKey;
				const id = ++this.elementIdCounter;
				const path = currentState.parentPath;
				const fullkey = key !== null ? `${path}${typeof key === 'number' ? `[${key}]` : `.${key}`}` : path;
				const type = getJsonType(currentValue);
				const atom = !isContainer ? currentValue : null;

				this.currentRow = {
					key: key,
					value: isContainer ? JSON.stringify(currentValue) : currentValue,
					type: type,
					atom: atom,
					id: id,
					parent: currentState.parentId,
					fullkey: fullkey,
					path: path,
					_originalValue: isContainer ? currentValue : undefined, // Store original container
				};

				// We found a row to yield, break the loop and return
				this._isEof = false;
				return;
			}

			// If we have processed this node and its children haven't been pushed yet...
			if (isContainer && !currentState.childrenPushed) {
				currentState.childrenPushed = true; // Mark children as pushed
				const parentId = (this.currentRow as any).id;
				const parentFullKey = (this.currentRow as any).fullkey;

				// Push children in reverse order
				if (Array.isArray(currentValue)) {
					for (let i = currentValue.length - 1; i >= 0; i--) {
						this.stack.push({
							value: currentValue[i],
							parentPath: parentFullKey,
							parentKey: i,
							parentId: parentId,
							childrenPushed: false,
						});
					}
				} else { // Must be an object
					const keys = Object.keys(currentValue).sort().reverse();
					for (const objKey of keys) {
						this.stack.push({
							value: currentValue[objKey],
							parentPath: parentFullKey,
							parentKey: objKey,
							parentId: parentId,
							childrenPushed: false,
						});
					}
				}
				// Reset currentRow so the next loop iteration processes the first child
				this.currentRow = null;
				continue; // Go back to the start of the loop to process the newly pushed child
			}

			// If we're here, it means we've processed the node and its children (if any)
			// So, pop it from the stack and reset currentRow to null, continuing the loop
			this.stack.pop();
			this.currentRow = null;
		}

		// If the loop finishes, the stack is empty, so we are EOF
		this._isEof = true;
		this.currentRow = null;
	}

	// --- Implement Abstract Methods --- //

	async filter(idxNum: number, idxStr: string | null, constraints: ReadonlyArray<{ constraint: IndexConstraint, argvIndex: number }>, args: ReadonlyArray<SqlValue>): Promise<void> {
		const rootPath = this.table.rootPath;
		let startNode = this.table.parsedJson;
		if (rootPath) {
			startNode = evaluateJsonPathBasic(startNode, rootPath);
		}
		this.startIteration(startNode, rootPath);
	}

	async next(): Promise<void> {
		if (this._isEof) return;
		// Advance the state machine
		this.advanceToNextRow();
	}

	column(context: SqliteContext, index: number): number {
		if (!this.currentRow) {
			context.resultNull();
			return StatusCode.OK;
		}
		const colName = JSON_TREE_COLUMNS[index]?.name;

		if (colName === 'value') {
			const type = this.currentRow['type'];
			if (type === 'object' || type === 'array') {
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
		throw new SqliteError("Cannot get rowid for json_tree cursor (missing ID)", StatusCode.INTERNAL);
	}

	async close(): Promise<void> {
		this.reset();
	}
}

// --- Module Implementation (No Inheritance) --- //

export class JsonTreeModule implements VirtualTableModule<JsonTreeTable, JsonTreeCursor, JsonConfig> {
	xConnect(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string, options: JsonConfig): JsonTreeTable {
		const table = new JsonTreeTable(db, this, schemaName, tableName, options.jsonSource, options.rootPath);
		return table;
	}

	xCreate(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string, options: JsonConfig): JsonTreeTable {
		return this.xConnect(db, pAux, moduleName, schemaName, tableName, options);
	}

	// Add missing xBestIndex implementation to the module
	xBestIndex(db: Database, tableInfo: TableSchema, indexInfo: IndexInfo): number {
		indexInfo.estimatedCost = 100000; // Arbitrary large cost
		indexInfo.idxNum = 0; // Plan 0: Full iteration
		indexInfo.idxStr = null;
		indexInfo.orderByConsumed = false; // Output order is depth-first
		// Indicate no constraints are used by the plan itself
		indexInfo.aConstraintUsage = Array.from({ length: indexInfo.nConstraint }, () => ({ argvIndex: 0, omit: false }));
		return StatusCode.OK;
	}

	// Add missing xDestroy implementation to the module (no-op)
	async xDestroy(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string): Promise<void> {
		// json_tree is ephemeral, no persistent state to destroy at the module level
		return Promise.resolve();
	}

	// Instance-specific methods are now on JsonTreeTable
}
