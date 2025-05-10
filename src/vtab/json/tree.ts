import { VirtualTable } from '../table.js';
import { VirtualTableCursor } from '../cursor.js';
import type { VirtualTableModule, BaseModuleConfig } from '../module.js';
import type { IndexInfo } from '../indexInfo.js';
import { type SqlValue, StatusCode, SqlDataType } from '../../common/types.js';
import { SqliterError } from '../../common/errors.js';
import type { SqliterContext } from '../../func/context.js';
import type { Database } from '../../core/database.js';
import { safeJsonParse, evaluateJsonPathBasic, getJsonType } from '../../func/builtins/json-helpers.js';
import type { TableSchema } from '../../schema/table.js';
import { createDefaultColumnSchema } from '../../schema/column.js';
import { buildColumnIndexMap } from '../../schema/table.js';
import type { IndexConstraint } from '../indexInfo.js';
import { jsonStringify } from '../../util/serialization.js';

/**
 * Configuration interface for JSON virtual tables
 */
interface JsonConfig extends BaseModuleConfig {
	jsonSource: SqlValue;
	runtimeArgs?: ReadonlyArray<SqlValue>;
	rootPath?: SqlValue;
}

// Schema definition for json_tree table (identical to json_each)
const JSON_TREE_SCHEMA = Object.freeze([
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

/**
 * Virtual table implementation for json_tree function
 */
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
			throw new SqliterError(`Invalid JSON provided to ${tableName}`, StatusCode.ERROR);
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
			vtabModuleName: 'json_tree',
			isWithoutRowid: false,
			isStrict: false,
			isView: false,
		});
	}

	async xOpen(): Promise<JsonTreeCursor<this>> {
		return new JsonTreeCursor(this);
	}

	xBestIndex(indexInfo: IndexInfo): number {
		indexInfo.estimatedCost = 100000;
		indexInfo.idxNum = 0;
		indexInfo.idxStr = null;
		indexInfo.orderByConsumed = false;

		// No constraints are used
		indexInfo.aConstraintUsage = Array.from(
			{ length: indexInfo.nConstraint },
			() => ({ argvIndex: 0, omit: false })
		);
		return StatusCode.OK;
	}

	async xUpdate(): Promise<{ rowid?: bigint }> {
		throw new SqliterError("json_tree table is read-only", StatusCode.READONLY);
	}

	async xBegin() { return Promise.resolve(); }
	async xSync() { return Promise.resolve(); }
	async xCommit() { return Promise.resolve(); }
	async xRollback() { return Promise.resolve(); }
	async xRename() {
		throw new SqliterError("Cannot rename json_tree table", StatusCode.ERROR);
	}

	async xDisconnect(): Promise<void> { /* No-op */ }
	async xDestroy(): Promise<void> { /* No-op */ }
}

/**
 * Represents the state of a depth-first iteration through the JSON structure
 */
interface IterationState {
	value: any;
	parentPath: string;
	parentKey: string | number | null;
	parentId: number;
	childrenPushed: boolean;
}

/**
 * Cursor implementation for json_tree table
 * Uses depth-first traversal, including both nodes and their children
 */
class JsonTreeCursor<T extends JsonTreeTable> extends VirtualTableCursor<T> {
	private stack: IterationState[] = [];
	private currentRow: Record<string, SqlValue> | null = null;
	private currentState: IterationState | null = null;
	private originalValue: any = null;
	private elementIdCounter: number = 0;

	constructor(table: T) {
		super(table);
		this._isEof = true;
	}

	/**
	 * Resets the cursor state
	 */
	reset(): void {
		this.stack = [];
		this.currentRow = null;
		this.currentState = null;
		this.originalValue = null;
		this._isEof = true;
		this.elementIdCounter = 0;
	}

	/**
	 * Initializes iteration based on the JSON start node and optional root path
	 */
	private startIteration(startNode: any, rootPath: string | null): void {
		this.reset();
		if (startNode !== undefined) {
			this.stack.push({
				value: startNode,
				parentPath: '',
				parentKey: null,
				parentId: 0,
				childrenPushed: false,
			});
			this._isEof = false;
			this.advanceToNextRow();
		} else {
			this._isEof = true;
		}
	}

	/**
	 * Advances to the next row in the JSON tree using depth-first traversal
	 * First visits each node, then processes its children
	 */
	private advanceToNextRow(): void {
		while (this.stack.length > 0) {
			const state = this.stack[this.stack.length - 1];
			const value = state.value;
			const isContainer = typeof value === 'object' && value !== null;

			// If we haven't processed this node (yielded its row) yet...
			if (!this.currentState || this.currentState !== state) {
				const key = state.parentKey;
				const id = ++this.elementIdCounter;
				const path = state.parentPath;
				const fullkey = key !== null ? `${path}${typeof key === 'number' ? `[${key}]` : `.${key}`}` : path;
				const type = getJsonType(value);
				const atom = !isContainer ? value : null;

				this.currentRow = {
					key: key,
					value: isContainer ? jsonStringify(value) : value,
					type: type,
					atom: atom,
					id: id,
					parent: state.parentId,
					fullkey: fullkey,
					path: path,
				};

				// Save references to current state and original value for later use
				this.currentState = state;
				this.originalValue = isContainer ? value : undefined;

				// Found a row to yield, break the loop and return
				this._isEof = false;
				return;
			}

			// If we have processed this node and its children haven't been pushed yet...
			if (isContainer && !state.childrenPushed) {
				state.childrenPushed = true;
				const parentId = this.currentRow?.id as number;
				const parentFullKey = this.currentRow?.fullkey as string;

				// Push children in reverse order
				if (Array.isArray(value)) {
					for (let i = value.length - 1; i >= 0; i--) {
						this.stack.push({
							value: value[i],
							parentPath: parentFullKey,
							parentKey: i,
							parentId: parentId,
							childrenPushed: false,
						});
					}
				} else {
					const keys = Object.keys(value).sort().reverse();
					for (const objKey of keys) {
						this.stack.push({
							value: value[objKey],
							parentPath: parentFullKey,
							parentKey: objKey,
							parentId: parentId,
							childrenPushed: false,
						});
					}
				}

				// Reset current state so the next loop iteration processes the first child
				this.currentRow = null;
				this.currentState = null;
				this.originalValue = null;
				continue;
			}

			// If we've processed the node and its children, pop it from the stack
			this.stack.pop();
			this.currentRow = null;
			this.currentState = null;
			this.originalValue = null;
		}

		// If the loop finishes, the stack is empty, so we are EOF
		this._isEof = true;
		this.currentRow = null;
		this.currentState = null;
		this.originalValue = null;
	}

	/**
	 * Initializes the cursor for a new query with the given constraints
	 * For json_tree, we don't use the constraints - we just traverse the entire JSON structure
	 */
	async filter(
		idxNum: number,
		idxStr: string | null,
		constraints: ReadonlyArray<{ constraint: IndexConstraint, argvIndex: number }>,
		args: ReadonlyArray<SqlValue>
	): Promise<void> {
		const rootPath = this.table.rootPath;
		let startNode = this.table.parsedJson;
		if (rootPath) {
			startNode = evaluateJsonPathBasic(startNode, rootPath);
		}
		this.startIteration(startNode, rootPath);
	}

	/**
	 * Advances the cursor to the next row in the result set
	 */
	async next(): Promise<void> {
		if (this._isEof) return;
		this.advanceToNextRow();
	}

	/**
	 * Returns the value for the specified column of the current row
	 */
	column(context: SqliterContext, index: number): number {
		if (!this.currentRow) {
			context.resultNull();
			return StatusCode.OK;
		}
		const colName = JSON_TREE_COLUMNS[index]?.name;

		if (colName === 'value') {
			const type = this.currentRow['type'];
			if (type === 'object' || type === 'array') {
				context.resultValue(this.originalValue !== undefined ? jsonStringify(this.originalValue) : null);
			} else {
				context.resultValue(this.currentRow[colName] ?? null);
			}
		} else {
			context.resultValue(this.currentRow[colName] ?? null);
		}
		return StatusCode.OK;
	}

	/**
	 * Returns the rowid for the current row
	 */
	async rowid(): Promise<bigint> {
		if (!this.currentRow) {
			throw new SqliterError("Cursor is not pointing to a valid row", StatusCode.MISUSE);
		}
		const id = this.currentRow['id'];
		if (typeof id === 'number') {
			return BigInt(id);
		}
		throw new SqliterError("Cannot get rowid for json_tree cursor (missing ID)", StatusCode.INTERNAL);
	}

	/**
	 * Closes the cursor and releases resources
	 */
	async close(): Promise<void> {
		this.reset();
	}
}

/**
 * Module implementation for json_tree virtual table function
 */
export class JsonTreeModule implements VirtualTableModule<JsonTreeTable, JsonTreeCursor<JsonTreeTable>, JsonConfig> {
	xConnect(
		db: Database,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string,
		options: JsonConfig
	): JsonTreeTable {
		const table = new JsonTreeTable(db, this, schemaName, tableName, options.jsonSource, options.rootPath);
		return table;
	}

	xCreate(
		db: Database,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string,
		options: JsonConfig
	): JsonTreeTable {
		return this.xConnect(db, pAux, moduleName, schemaName, tableName, options);
	}

	xBestIndex(db: Database, tableInfo: TableSchema, indexInfo: IndexInfo): number {
		indexInfo.estimatedCost = 100000;
		indexInfo.idxNum = 0;
		indexInfo.idxStr = null;
		indexInfo.orderByConsumed = false;

		// No constraints are used
		indexInfo.aConstraintUsage = Array.from(
			{ length: indexInfo.nConstraint },
			() => ({ argvIndex: 0, omit: false })
		);
		return StatusCode.OK;
	}

	async xDestroy(
		db: Database,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string
	): Promise<void> {
		return Promise.resolve();
	}
}
