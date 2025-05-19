import { VirtualTable } from '../table.js';
import type { VirtualTableModule, BaseModuleConfig } from '../module.js';
import type { IndexInfo } from '../indexInfo.js';
import { type SqlValue, StatusCode, SqlDataType, type Row, type RowIdRow } from '../../common/types.js';
import { SqliterError } from '../../common/errors.js';
import type { Database } from '../../core/database.js';
import { safeJsonParse, evaluateJsonPathBasic, getJsonType } from '../../func/builtins/json-helpers.js';
import type { TableSchema } from '../../schema/table.js';
import { createDefaultColumnSchema } from '../../schema/column.js';
import { buildColumnIndexMap } from '../../schema/table.js';
import type { IndexConstraint } from '../indexInfo.js';
import { jsonStringify } from '../../util/serialization.js';
import type { FilterInfo } from '../filter-info.js';

/**
 * Configuration interface for JSON virtual tables
 */
interface JsonConfig extends BaseModuleConfig {
	jsonSource: SqlValue;
	runtimeArgs?: ReadonlyArray<SqlValue>;
	rootPath?: SqlValue;
}

// Schema definition for json_each table
const JSON_EACH_SCHEMA = Object.freeze([
	{ name: 'key', affinity: SqlDataType.INTEGER | SqlDataType.TEXT },
	{ name: 'value', affinity: SqlDataType.TEXT },
	{ name: 'type', affinity: SqlDataType.TEXT },
	{ name: 'atom', affinity: SqlDataType.TEXT },
	{ name: 'id', affinity: SqlDataType.INTEGER },
	{ name: 'parent', affinity: SqlDataType.INTEGER },
	{ name: 'fullkey', affinity: SqlDataType.TEXT },
	{ name: 'path', affinity: SqlDataType.TEXT },
]);

const JSON_EACH_COLUMNS = Object.freeze(
	JSON_EACH_SCHEMA.map(col => ({
		...createDefaultColumnSchema(col.name),
		affinity: col.affinity,
	}))
);
const JSON_EACH_COLUMN_MAP = Object.freeze(buildColumnIndexMap(JSON_EACH_COLUMNS));

/**
 * Virtual table implementation for json_each function
 */
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
			throw new SqliterError(`Invalid JSON provided to ${tableName}`, StatusCode.ERROR);
		}

		// Define fixed schema
		this.tableSchema = Object.freeze({
			name: tableName,
			schemaName: schemaName,
			checkConstraints: [],
			columns: JSON_EACH_COLUMNS,
			columnIndexMap: JSON_EACH_COLUMN_MAP,
			primaryKeyDefinition: [],
			vtabModule: module as any,
			vtabModuleName: 'json_each',
			isWithoutRowid: false,
			isStrict: false,
			isView: false,
			vtabAuxData: undefined,
			vtabArgs: [],
			indexes: [],
			isTemporary: false,
			subqueryAST: undefined,
		});
	}

	xBestIndex(indexInfo: IndexInfo): number {
		// json_each doesn't use indexes, it just iterates
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
		throw new SqliterError("json_each table is read-only", StatusCode.READONLY);
	}

	async xBegin() { return Promise.resolve(); }
	async xSync() { return Promise.resolve(); }
	async xCommit() { return Promise.resolve(); }
	async xRollback() { return Promise.resolve(); }
	async xRename() {
		throw new SqliterError("Cannot rename json_each table", StatusCode.ERROR);
	}

	async xDisconnect(): Promise<void> { /* No-op */ }
	async xDestroy(): Promise<void> { /* No-op */ }

	async* xQuery(_filterInfo: FilterInfo): AsyncIterable<RowIdRow> {
		const rootPath = this.rootPath;
		let startNode = this.parsedJson;
		if (rootPath) {
			startNode = evaluateJsonPathBasic(startNode, rootPath);
		}

		// Directly use the iteration logic previously in JsonEachCursor._internalIteratorGenerator
		const localStack: { value: any; parentPath: string; parentKey: string | number | null; parentId: number; }[] = [];
		let localElementIdCounter = 0;

		if (startNode !== undefined) {
			localStack.push({
				value: startNode,
				parentPath: '',
				parentKey: null,
				parentId: 0,
			});
		}

		while (localStack.length > 0) {
			const currentState = localStack[localStack.length - 1];
			const currentValue = currentState.value;

			const key = currentState.parentKey;
			const id = localElementIdCounter++;
			const path = currentState.parentPath;
			const fullkey = key !== null ? `${path}${typeof key === 'number' ? `[${key}]` : `.${key}`}` : path;
			const type = getJsonType(currentValue);
			const atom = (type === 'object' || type === 'array') ? null : currentValue;

			const valueForColumn = (type === 'object' || type === 'array') ? jsonStringify(currentValue) : currentValue;

			const row: Row = [
				key,
				valueForColumn,
				type,
				atom,
				id,
				currentState.parentId,
				fullkey,
				path
			];

			localStack.pop(); // Pop the current state as it's now processed

			if (Array.isArray(currentValue)) {
				for (let i = currentValue.length - 1; i >= 0; i--) {
					localStack.push({
						value: currentValue[i],
						parentPath: fullkey,
						parentKey: i,
						parentId: id,
					});
				}
			} else if (typeof currentValue === 'object' && currentValue !== null) {
				const keys = Object.keys(currentValue).sort().reverse(); // SQLite's json_each iterates in sorted key order
				for (const objKey of keys) {
					localStack.push({
						value: currentValue[objKey],
						parentPath: fullkey,
						parentKey: objKey,
						parentId: id,
					});
				}
			}
			yield [BigInt(id), row];
		}
	}
}

/**
 * Module implementation for json_each virtual table function
 */
export class JsonEachModule implements VirtualTableModule<JsonEachTable, JsonConfig> {
	xConnect(
		db: Database,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string,
		options: JsonConfig
	): JsonEachTable {
		const table = new JsonEachTable(db, this, schemaName, tableName, options.jsonSource, options.rootPath);
		return table;
	}

	xCreate(
		db: Database,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string,
		options: JsonConfig
	): JsonEachTable {
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
