import type { Row, SqlValue, JSONValue } from "../../common/types.js";
import { createTableValuedFunction } from "../registration.js";
import { QuereusError } from "../../common/errors.js";
import { StatusCode } from "../../common/types.js";
import { safeJsonParse, evaluateJsonPathBasic, getJsonType } from "./json-helpers.js";
import { jsonStringify } from "../../util/serialization.js";
import { INTEGER_TYPE, TEXT_TYPE } from "../../types/builtin-types.js";

// JSON Each table-valued function
export const jsonEachFunc = createTableValuedFunction(
	{
		name: 'json_each',
		numArgs: -1, // Variable arguments (1 or 2)
		deterministic: true,
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'key', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'value', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'type', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'atom', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'id', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'parent', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'fullkey', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'path', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true }
			],
			keys: [],
			rowConstraints: []
		}
	},
	async function* (jsonText: SqlValue, rootPath?: SqlValue): AsyncIterable<Row> {
		if (typeof jsonText !== 'string') {
			throw new QuereusError('json_each() requires a JSON string as first argument', StatusCode.ERROR);
		}

		const parsedJson = safeJsonParse(jsonText);
		if (parsedJson === null && typeof jsonText === 'string') {
			throw new QuereusError('Invalid JSON provided to json_each', StatusCode.ERROR);
		}

		const rootPathStr = (typeof rootPath === 'string' && rootPath) ? rootPath : null;
		let startNode: JSONValue | undefined = parsedJson;

		if (rootPathStr) {
			startNode = evaluateJsonPathBasic(startNode, rootPathStr);
		}

		const localStack: { value: JSONValue; parentPath: string; parentKey: string | number | null; parentId: number; }[] = [];
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
			localStack.pop();
			const currentValue = currentState.value;

			const key = currentState.parentKey;
			const id = localElementIdCounter++;
			const path = currentState.parentPath;
			const fullkey = key !== null ? `${path}${typeof key === 'number' ? `[${key}]` : `.${key}`}` : path;
			const type = getJsonType(currentValue);
			const atom: SqlValue = (type === 'object' || type === 'array') ? null : currentValue as SqlValue;
			const valueForColumn: SqlValue = (type === 'object' || type === 'array') ? jsonStringify(currentValue) : currentValue as SqlValue;

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

			if (Array.isArray(currentValue)) {
				for (let i = currentValue.length - 1; i >= 0; i--) {
					localStack.push({
						value: currentValue[i],
						parentPath: fullkey,
						parentKey: i,
						parentId: id,
					});
				}
			} else if (typeof currentValue === 'object' && currentValue !== null && !Array.isArray(currentValue)) {
				const keys = Object.keys(currentValue).sort().reverse();
				for (const objKey of keys) {
					localStack.push({
						value: (currentValue as Record<string, JSONValue>)[objKey],
						parentPath: fullkey,
						parentKey: objKey,
						parentId: id,
					});
				}
			}
			yield row;
		}
	}
);

// JSON Tree table-valued function
export const jsonTreeFunc = createTableValuedFunction(
	{
		name: 'json_tree',
		numArgs: -1, // Variable arguments (1 or 2)
		deterministic: true,
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'key', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'value', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'type', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'atom', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'id', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'parent', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'fullkey', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'path', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true }
			],
			keys: [],
			rowConstraints: []
		}
	},
	async function* (jsonText: SqlValue, rootPath?: SqlValue): AsyncIterable<Row> {
		if (typeof jsonText !== 'string') {
			throw new QuereusError('json_tree() requires a JSON string as first argument', StatusCode.ERROR);
		}

		const parsedJson = safeJsonParse(jsonText);
		if (parsedJson === null && typeof jsonText === 'string') {
			throw new QuereusError('Invalid JSON provided to json_tree', StatusCode.ERROR);
		}

		const rootPathStr = (typeof rootPath === 'string' && rootPath) ? rootPath : null;
		let startNode: JSONValue | undefined = parsedJson;

		if (rootPathStr) {
			startNode = evaluateJsonPathBasic(startNode, rootPathStr);
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
				yield row;

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
);
