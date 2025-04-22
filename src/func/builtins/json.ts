import { FunctionFlags } from '../../common/constants';
import type { SqlValue } from '../../common/types';
import { createScalarFunction, createAggregateFunction } from '../registration';
import type { SqliteContext } from '../context';
// Import helpers from the new location
import { safeJsonParse, resolveJsonPathForModify, prepareJsonValue, deepCopyJson, getJsonType } from './json-helpers';
// Import fast-json-patch
import { applyPatch, type Operation } from 'fast-json-patch';

/* --- REMOVED HELPER DEFINITIONS --- */
/*
function safeJsonParse(jsonString: SqlValue): any | null { ... }
function evaluateJsonPath(data: any, path: string): any | undefined { ... }
function resolveJsonPathForModify(data: any, path: string): { ... } | null { ... }
function prepareJsonValue(value: SqlValue): any { ... }
function deepCopyJson(data: any): any { ... }
function getJsonType(value: any): string { ... }
*/

// --- JSON Functions --- //

// json_valid(X)
const jsonValidFuncImpl = (json: SqlValue): SqlValue => {
	return safeJsonParse(json) !== null ? 1 : 0;
};
export const jsonValidFunc = createScalarFunction(
	{ name: 'json_valid', numArgs: 1, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC },
	jsonValidFuncImpl
);

// json_type(X, P?)
const jsonTypeFuncImpl = (json: SqlValue, path?: SqlValue): SqlValue => {
	const data = safeJsonParse(json);
	if (data === null && typeof json === 'string') return null; // Invalid JSON input

	let targetValue = data;
	if (path !== undefined && path !== null) {
		if (typeof path !== 'string') return 'null'; // Invalid path
		// Use the more robust resolver here?
		// targetValue = evaluateJsonPath(data, path);
		const resolved = resolveJsonPathForModify(data, path);
		targetValue = resolved?.exists ? resolved.value : undefined;
		// If path evaluation leads nowhere, SQLite returns NULL type
		if (targetValue === undefined) return null;
	}
	return getJsonType(targetValue);
};
export const jsonTypeFunc = createScalarFunction(
	{ name: 'json_type', numArgs: -1, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC },
	jsonTypeFuncImpl
);

// json_extract(X, P1, P2, ...)
const jsonExtractFuncImpl = (json: SqlValue, ...paths: SqlValue[]): SqlValue => {
	const data = safeJsonParse(json);
	if (data === null && typeof json === 'string') return null; // Return NULL if JSON is invalid

	if (paths.length === 0) return null; // No paths provided

	// SQLite json_extract: Find the first path that resolves
	let extractedValue: any = undefined;
	for (const pathVal of paths) {
		if (typeof pathVal === 'string') {
			// Use the more robust resolver
			// extractedValue = evaluateJsonPath(data, pathVal);
			const resolved = resolveJsonPathForModify(data, pathVal);
			extractedValue = resolved?.exists ? resolved.value : undefined;
			// Stop at the first path that successfully extracts a value (even if null)
			if (extractedValue !== undefined) {
				break;
			}
		} else {
			// Invalid path type itself results in overall NULL
			return null;
		}
	}

	// Map the extracted JS value to the corresponding SQL type
	if (extractedValue === undefined) {
		return null; // Path did not resolve
	} else if (extractedValue === null) {
		return null;
	} else if (typeof extractedValue === 'boolean') {
		return extractedValue ? 1 : 0;
	} else if (typeof extractedValue === 'number') {
		return extractedValue; // Return as INTEGER or REAL
	} else if (typeof extractedValue === 'string') {
		return extractedValue;
	} else if (typeof extractedValue === 'object') {
		// Return arrays/objects as JSON strings
		try {
			return JSON.stringify(extractedValue);
		} catch (e) {
			return null; // Should not happen for valid extracted JSON parts
		}
	} else {
		// Should not happen for valid JSON (e.g., bigint, symbol, function)
		return null;
	}
};
export const jsonExtractFunc = createScalarFunction(
	{ name: 'json_extract', numArgs: -1, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC },
	jsonExtractFuncImpl
);

// json_quote(X)
const jsonQuoteFuncImpl = (value: SqlValue): SqlValue => {
	if (value === null) return 'null';
	switch (typeof value) {
		case 'number':
			if (!Number.isFinite(value)) return 'null'; // JSON doesn't support Infinity/NaN
			return String(value);
		case 'boolean':
			return value ? 'true' : 'false';
		case 'string':
			return JSON.stringify(value); // Correctly escapes the string
		// Blobs and BigInts are not directly representable in standard JSON,
		// SQLite json_quote might handle them differently (e.g., error or specific format).
		// For now, let's return NULL for these.
		case 'bigint':
		case 'object': // Catches Uint8Array
		default:
			return null;
	}
};
export const jsonQuoteFunc = createScalarFunction(
	{ name: 'json_quote', numArgs: 1, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC },
	jsonQuoteFuncImpl
);

// json_array(X, Y, ...)
const jsonArrayFuncImpl = (...args: SqlValue[]): SqlValue => {
	// Values need to be converted to valid JSON representations before stringifying
	const jsonCompatibleArgs = args.map(arg => prepareJsonValue(arg)); // Use helper
	try {
		return JSON.stringify(jsonCompatibleArgs);
	} catch (e) {
		return null; // Should not happen with basic types
	}
};
export const jsonArrayFunc = createScalarFunction(
	{ name: 'json_array', numArgs: -1, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC },
	jsonArrayFuncImpl
);

// json_object(N1, V1, N2, V2, ...)
const jsonObjectFuncImpl = (...args: SqlValue[]): SqlValue => {
	if (args.length % 2 !== 0) {
		// SQLite json_object returns NULL if odd number of args
		return null;
	}
	const obj: Record<string, any> = {};
	for (let i = 0; i < args.length; i += 2) {
		const key = args[i];
		const value = args[i + 1];
		if (typeof key !== 'string') {
			// SQLite requires keys to be strings
			return null;
		}
		// Convert value to JSON compatible using helper
		obj[key] = prepareJsonValue(value);
	}
	try {
		return JSON.stringify(obj);
	} catch (e) {
		return null;
	}
};
export const jsonObjectFunc = createScalarFunction(
	{ name: 'json_object', numArgs: -1, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC },
	jsonObjectFuncImpl
);

// --- Additional JSON Functions --- //

// json_array_length(json, path?)
const jsonArrayLengthFuncImpl = (json: SqlValue, path?: SqlValue): SqlValue => {
	const data = safeJsonParse(json);
	if (data === null && typeof json === 'string') return null;

	let targetValue = data;
	if (path !== undefined && path !== null) {
		if (typeof path !== 'string') return 0; // Invalid path -> 0 length
		const resolved = resolveJsonPathForModify(data, path);
		targetValue = resolved?.exists ? resolved.value : undefined;
	}

	if (Array.isArray(targetValue)) {
		return targetValue.length;
	} else {
		// If the target exists but is not an array, SQLite returns 0
		// If the path doesn't resolve (targetValue is undefined), return 0?
		// Let's return 0 if not an array, consistent with SQLite.
		return 0;
	}
};
export const jsonArrayLengthFunc = createScalarFunction(
	{ name: 'json_array_length', numArgs: -1, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC },
	jsonArrayLengthFuncImpl
);

// json_patch(json, patch)
const jsonPatchFuncImpl = (json: SqlValue, patchVal: SqlValue): SqlValue => {
	const data = safeJsonParse(json);
	// JSON Patches must be JSON arrays
	const patch = safeJsonParse(patchVal);

	if (data === null && typeof json === 'string') return null; // Invalid target JSON
	if (!Array.isArray(patch)) return null; // Invalid patch JSON (must be array)

	try {
		// fast-json-patch might throw on invalid patch operations or test failures
		// applyPatch mutates by default, but since `data` is freshly parsed, it's okay.
		// If data came from elsewhere, we might need deepCopyJson first.
		const result = applyPatch(data, patch as Operation[], true /* validate operations */).newDocument;
		return JSON.stringify(result);
	} catch (e: any) {
		console.error(`json_patch failed: ${e?.message}`, e);
		return null; // Return NULL on patch failure
	}
};
export const jsonPatchFunc = createScalarFunction(
	{ name: 'json_patch', numArgs: 2, flags: FunctionFlags.UTF8 }, // Not deterministic as patch content varies
	jsonPatchFuncImpl
);

// --- Manipulation Functions --- //

// json_insert(JSON, PATH, VALUE, PATH, VALUE, ...)
const jsonInsertFuncImpl = (json: SqlValue, ...args: SqlValue[]): SqlValue => {
	let data = safeJsonParse(json);
	if (data === null && typeof json === 'string') return null; // Invalid JSON input
	if (args.length === 0 || args.length % 2 !== 0) return null; // Need path/value pairs

	// Work on a copy
	let currentData = deepCopyJson(data);

	for (let i = 0; i < args.length; i += 2) {
		const pathVal = args[i];
		const valueVal = args[i + 1];

		if (typeof pathVal !== 'string') return null; // Path must be string

		const preparedValue = prepareJsonValue(valueVal);
		const pathInfo = resolveJsonPathForModify(currentData, pathVal);

		if (pathInfo === null) continue; // Ignore invalid paths

		const { parent, key, exists } = pathInfo;

		if (!exists) {
			if (parent === null) continue; // Cannot insert at root if it doesn't exist (shouldn't happen)

			if (Array.isArray(parent) && typeof key === 'number') {
				if (key === parent.length) {
					parent.push(preparedValue);
				} else if (key < parent.length) {
					parent.splice(key, 0, preparedValue); // Insert *before* existing element
				}
				// Ignore if key > parent.length?
			} else if (typeof parent === 'object' && typeof key === 'string') {
				parent[key] = preparedValue;
			}
			// else: Cannot insert into non-container or invalid key type - ignore
		}
		// If path *does* exist, json_insert does nothing.
	}

	try {
		return JSON.stringify(currentData);
	} catch (e) {
		return null;
	}
};
export const jsonInsertFunc = createScalarFunction(
	{ name: 'json_insert', numArgs: -1, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC },
	jsonInsertFuncImpl
);

// json_replace(JSON, PATH, VALUE, PATH, VALUE, ...)
const jsonReplaceFuncImpl = (json: SqlValue, ...args: SqlValue[]): SqlValue => {
	let data = safeJsonParse(json);
	if (data === null && typeof json === 'string') return null;
	if (args.length === 0 || args.length % 2 !== 0) return null;

	let currentData = deepCopyJson(data);

	for (let i = 0; i < args.length; i += 2) {
		const pathVal = args[i];
		const valueVal = args[i + 1];

		if (typeof pathVal !== 'string') return null;

		const preparedValue = prepareJsonValue(valueVal);
		const pathInfo = resolveJsonPathForModify(currentData, pathVal);

		if (pathInfo === null) continue; // Ignore invalid paths

		const { parent, key, exists } = pathInfo;

		if (exists) {
			if (parent === null && key === '') {
				// Replace the root value
				currentData = preparedValue;
			} else if (parent !== null && typeof key === 'string' && typeof parent === 'object' && !Array.isArray(parent)) {
				parent[key] = preparedValue;
			} else if (parent !== null && typeof key === 'number' && Array.isArray(parent)) {
				if (key >= 0 && key < parent.length) {
					parent[key] = preparedValue;
				}
			}
			// else: Cannot replace non-existent or invalid path - ignore
		}
		// If path does *not* exist, json_replace does nothing.
	}

	try {
		return JSON.stringify(currentData);
	} catch (e) {
		return null;
	}
};
export const jsonReplaceFunc = createScalarFunction(
	{ name: 'json_replace', numArgs: -1, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC },
	jsonReplaceFuncImpl
);

// json_set(JSON, PATH, VALUE, PATH, VALUE, ...)
const jsonSetFuncImpl = (json: SqlValue, ...args: SqlValue[]): SqlValue => {
	let data = safeJsonParse(json);
	if (data === null && typeof json === 'string') return null;
	if (args.length === 0 || args.length % 2 !== 0) return null;

	let currentData = deepCopyJson(data);

	for (let i = 0; i < args.length; i += 2) {
		const pathVal = args[i];
		const valueVal = args[i + 1];

		if (typeof pathVal !== 'string') return null;

		const preparedValue = prepareJsonValue(valueVal);
		// Pass createParents = true to enable intermediate creation
		const pathInfo = resolveJsonPathForModify(currentData, pathVal, true);

		if (pathInfo === null) continue; // Ignore invalid paths

		const { parent, key, exists } = pathInfo;

		if (parent === null && key === '') {
			// Set the root value
			currentData = preparedValue;
		} else if (parent !== null) {
			if (typeof parent === 'object' && !Array.isArray(parent) && typeof key === 'string') {
				parent[key] = preparedValue; // Set object property (create or replace)
			} else if (Array.isArray(parent) && typeof key === 'number') {
				if (key >= 0 && key < parent.length) {
					parent[key] = preparedValue; // Replace existing array element
				} else if (key === parent.length) {
					parent.push(preparedValue); // Append to array
				} else if (key > parent.length) {
					// Pad array with nulls and append (SQLite behavior)
					while (parent.length < key) {
						parent.push(null);
					}
					parent.push(preparedValue);
				}
				// Ignore negative index?
			}
			// NOTE: This implementation does *not* create intermediate objects/arrays
			// if the parent itself doesn't exist. A full json_set would need recursion here.
		}
	}

	try {
		return JSON.stringify(currentData);
	} catch (e) {
		return null;
	}
};
export const jsonSetFunc = createScalarFunction(
	{ name: 'json_set', numArgs: -1, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC },
	jsonSetFuncImpl
);

// json_remove(JSON, PATH, PATH, ...)
const jsonRemoveFuncImpl = (json: SqlValue, ...paths: SqlValue[]): SqlValue => {
	let data = safeJsonParse(json);
	if (data === null && typeof json === 'string') return null; // Invalid JSON input
	if (paths.length === 0) return JSON.stringify(data); // No paths means no change

	let currentData = deepCopyJson(data);

	for (const pathVal of paths) {
		if (typeof pathVal !== 'string') return null; // Path must be string

		const pathInfo = resolveJsonPathForModify(currentData, pathVal);

		if (pathInfo === null || !pathInfo.exists || pathInfo.parent === null) {
			// Invalid path, path doesn't exist, or trying to remove root - ignore
			continue;
		}

		const { parent, key } = pathInfo;

		if (Array.isArray(parent) && typeof key === 'number') {
			if (key >= 0 && key < parent.length) {
				parent.splice(key, 1); // Remove array element
			}
		} else if (typeof parent === 'object' && typeof key === 'string') {
			if (Object.prototype.hasOwnProperty.call(parent, key)) {
				delete parent[key]; // Remove object property
			}
		}
		// else: Cannot remove from non-container or invalid key type - ignore
	}

	try {
		return JSON.stringify(currentData);
	} catch (e) {
		return null;
	}
};
export const jsonRemoveFunc = createScalarFunction(
	{ name: 'json_remove', numArgs: -1, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC },
	jsonRemoveFuncImpl
);

// --- Aggregate Functions --- //

// json_group_array(value)
const jsonGroupArrayStep = (acc: any[] | undefined, value: SqlValue): any[] => {
	const currentAcc = acc ?? [];
	// SQLite's json_group_array includes NULLs, unlike json_array function
	const preparedValue = prepareJsonValue(value);
	currentAcc.push(preparedValue);
	return currentAcc;
};
const jsonGroupArrayFinal = (acc: any[] | undefined): SqlValue => {
	try {
		// Returns NULL if the group is empty, otherwise the JSON array string
		return acc && acc.length > 0 ? JSON.stringify(acc) : null;
	} catch (e) {
		return null;
	}
};
export const jsonGroupArrayFunc = createAggregateFunction(
	{ name: 'json_group_array', numArgs: 1, flags: FunctionFlags.UTF8, initialState: [] },
	jsonGroupArrayStep,
	jsonGroupArrayFinal
);

// json_group_object(name, value)
const jsonGroupObjectStep = (acc: Record<string, any> | undefined, name: SqlValue, value: SqlValue): Record<string, any> => {
	const currentAcc = acc ?? {};
	if (typeof name !== 'string' || name === null) {
		return currentAcc; // Skip if name is not a non-NULL string
	}
	// SQLite's json_group_object includes NULL values associated with keys
	const preparedValue = prepareJsonValue(value);
	currentAcc[name] = preparedValue;
	return currentAcc;
};
const jsonGroupObjectFinal = (acc: Record<string, any> | undefined): SqlValue => {
	try {
		// Returns NULL if the group is empty, otherwise the JSON object string
		return acc && Object.keys(acc).length > 0 ? JSON.stringify(acc) : null;
	} catch (e) {
		return null;
	}
};
export const jsonGroupObjectFunc = createAggregateFunction(
	{ name: 'json_group_object', numArgs: 2, flags: FunctionFlags.UTF8, initialState: {} },
	jsonGroupObjectStep,
	jsonGroupObjectFinal
);
