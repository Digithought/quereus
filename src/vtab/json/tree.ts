import { VirtualTable } from '../table.js';
import type { VirtualTableModule, BaseModuleConfig } from '../module.js';
import type { IndexInfo } from '../index-info.js';
import { type SqlValue, StatusCode, SqlDataType, type Row, type RowIdRow } from '../../common/types.js';
import { SqliterError } from '../../common/errors.js';
import type { Database } from '../../core/database.js';
import { safeJsonParse, evaluateJsonPathBasic, getJsonType } from '../../func/builtins/json-helpers.js';
import type { TableSchema } from '../../schema/table.js';
import { createDefaultColumnSchema } from '../../schema/column.js';
import { buildColumnIndexMap } from '../../schema/table.js';
import type { IndexConstraint } from '../index-info.js';
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
			vtabModule: module as any,
			vtabModuleName: 'json_tree',
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

	async* xQuery(_filterInfo: FilterInfo): AsyncIterable<RowIdRow> {
		const rootPath = this.rootPath;
		let startNode = this.parsedJson;
		if (rootPath) {
			startNode = evaluateJsonPathBasic(startNode, rootPath);
		}

		const localStack: { value: any; parentPath: string; parentKey: string | number | null; parentId: number; childrenPushed: boolean; }[] = [];
		let localElementIdCounter = 0;

		if (startNode !== undefined) {
			localStack.push({
				value: startNode,
				parentPath: '',
				parentKey: null,
				parentId: 0,
				childrenPushed: false,
			});
		}

		while (localStack.length > 0) {
			const state = localStack[localStack.length - 1];
			const value = state.value;
			const isContainer = typeof value === 'object' && value !== null;

			if (!state.childrenPushed) {
				const key = state.parentKey;
				const id = ++localElementIdCounter;
				const path = state.parentPath;
				const fullkey = key !== null ? `${path}${typeof key === 'number' ? `[${key}]` : `.${key}`}` : path;
				const type = getJsonType(value);
				const atom = !isContainer ? value : null;
				const valueForColumn = isContainer ? jsonStringify(value) : value;

				const row: Row = [
					key,
					valueForColumn,
					type,
					atom,
					id,
					state.parentId,
					fullkey,
					path
				];
				state.childrenPushed = true;
				yield [BigInt(id), row];

				if (isContainer) {
					const parentIdForRow = id;
					const parentFullKeyForRow = fullkey;

					if (Array.isArray(value)) {
						for (let i = value.length - 1; i >= 0; i--) {
							localStack.push({
								value: value[i],
								parentPath: parentFullKeyForRow,
								parentKey: i,
								parentId: parentIdForRow,
								childrenPushed: false,
							});
						}
					} else {
						const keys = Object.keys(value).sort().reverse();
						for (const objKey of keys) {
							localStack.push({
								value: value[objKey],
								parentPath: parentFullKeyForRow,
								parentKey: objKey,
								parentId: parentIdForRow,
								childrenPushed: false,
							});
						}
					}
					continue;
				}
			}
			localStack.pop();
		}
	}
}

/**
 * Module implementation for json_tree virtual table function
 */
export class JsonTreeModule implements VirtualTableModule<JsonTreeTable, JsonConfig> {
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
