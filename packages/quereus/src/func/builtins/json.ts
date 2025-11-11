import fastJsonPatch from 'fast-json-patch';
import type { Operation } from 'fast-json-patch';
const { applyPatch } = fastJsonPatch;

import { Type, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import { createLogger } from '../../common/logger.js';
import type { SqlValue, JSONValue } from '../../common/types.js';
import { createScalarFunction, createAggregateFunction } from '../registration.js';
import { safeJsonParse, resolveJsonPathForModify, prepareJsonValue, deepCopyJson, getJsonType } from './json-helpers.js';

const log = createLogger('func:builtins:json');
const errorLog = log.extend('error');

// --- JSON Functions --- //

// json_valid(X)
export const jsonValidFunc = createScalarFunction(
	{ name: 'json_valid', numArgs: 1, deterministic: true },
	(json: SqlValue): SqlValue => {
		return safeJsonParse(json) !== null ? 1 : 0;
	}
);

/**
 * Parse a simplified schema definition string into a TypeBox schema.
 * Supports a simplified syntax for common patterns:
 * - "integer" -> Type.Integer()
 * - "number" -> Type.Number()
 * - "string" -> Type.String()
 * - "boolean" -> Type.Boolean()
 * - "null" -> Type.Null()
 * - "[type]" -> Type.Array(type)
 * - "{prop:type,...}" -> Type.Object({prop:type,...})
 *
 * Examples:
 * - "[integer]" -> array of integers
 * - "{x:integer,y:number}" -> object with x:integer and y:number
 * - "[{x:integer}]" -> array of objects with x:integer
 */
function parseSchemaDefinition(schemaDef: string): TSchema | null {
	try {
		// Trim whitespace
		const trimmed = schemaDef.trim();

		// Base types
		if (trimmed === 'integer') return Type.Integer();
		if (trimmed === 'number') return Type.Number();
		if (trimmed === 'string') return Type.String();
		if (trimmed === 'boolean') return Type.Boolean();
		if (trimmed === 'null') return Type.Null();
		if (trimmed === 'any') return Type.Any();

		// Array type: [elementType]
		if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
			const elementDef = trimmed.slice(1, -1).trim();
			const elementSchema = parseSchemaDefinition(elementDef);
			if (elementSchema === null) return null;
			return Type.Array(elementSchema);
		}

		// Object type: {prop1:type1,prop2:type2,...}
		if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
			const content = trimmed.slice(1, -1).trim();
			if (content === '') return Type.Object({});

			// Parse properties - simple comma-separated key:type pairs
			const properties: Record<string, TSchema> = {};
			let depth = 0;
			let currentProp = '';
			let currentKey = '';
			let inKey = true;

			for (let i = 0; i < content.length; i++) {
				const char = content[i];

				if (char === '{' || char === '[') {
					depth++;
					currentProp += char;
					inKey = false;
				} else if (char === '}' || char === ']') {
					depth--;
					currentProp += char;
				} else if (char === ':' && depth === 0 && inKey) {
					currentKey = currentProp.trim();
					currentProp = '';
					inKey = false;
				} else if (char === ',' && depth === 0) {
					// End of property
					const propSchema = parseSchemaDefinition(currentProp.trim());
					if (propSchema === null) return null;
					properties[currentKey] = propSchema;
					currentProp = '';
					currentKey = '';
					inKey = true;
				} else {
					currentProp += char;
				}
			}

			// Handle last property
			if (currentKey && currentProp.trim()) {
				const propSchema = parseSchemaDefinition(currentProp.trim());
				if (propSchema === null) return null;
				properties[currentKey] = propSchema;
			}

			return Type.Object(properties);
		}

		// If we can't parse it, return null
		return null;
	} catch (e) {
		errorLog('parseSchemaDefinition failed: %O', e);
		return null;
	}
}

// json_schema(X, schema_def)
export const jsonSchemaFunc = createScalarFunction(
	{ name: 'json_schema', numArgs: 2, deterministic: true },
	(json: SqlValue, schemaDef: SqlValue): SqlValue => {
		// Schema definition must be a string
		if (typeof schemaDef !== 'string') return 0;

		// Parse the JSON value - need to check if it's valid JSON first
		// safeJsonParse returns null for both invalid JSON and valid JSON null
		// So we need to validate the JSON string first
		if (typeof json !== 'string') return 0;

		let data: JSONValue | null;
		try {
			data = JSON.parse(json) as JSONValue;
		} catch {
			return 0; // Invalid JSON
		}

		// Parse the schema definition
		const schema = parseSchemaDefinition(schemaDef);
		if (schema === null) return 0; // Invalid schema definition

		// Validate the data against the schema
		try {
			const isValid = Value.Check(schema, data);
			return isValid ? 1 : 0;
		} catch (e) {
			errorLog('json_schema validation failed: %O', e);
			return 0;
		}
	}
);

// json_type(X, P?)
export const jsonTypeFunc = createScalarFunction(
	{ name: 'json_type', numArgs: -1, deterministic: true },
	(json: SqlValue, path?: SqlValue): SqlValue => {
		const data = safeJsonParse(json);
		if (data === null && typeof json === 'string') return null; // Invalid JSON input

		let targetValue: JSONValue | undefined = data;
		if (path !== undefined && path !== null) {
			if (typeof path !== 'string') return 'null'; // Invalid path
			const resolved = resolveJsonPathForModify(data, path);
			targetValue = resolved?.exists ? resolved.value : undefined;
			// If path evaluation leads nowhere, SQLite returns NULL type
			if (targetValue === undefined) return null;
		}
		return getJsonType(targetValue as JSONValue);
	}
);

// json_extract(X, P1, P2, ...)
export const jsonExtractFunc = createScalarFunction(
	{ name: 'json_extract', numArgs: -1, deterministic: true },
	(json: SqlValue, ...paths: SqlValue[]): SqlValue => {
		const data = safeJsonParse(json);
		if (data === null && typeof json === 'string') return null; // Return NULL if JSON is invalid

		if (paths.length === 0) return null; // No paths provided

		// SQLite json_extract: Find the first path that resolves
		let extractedValue: any = undefined;
		for (const pathVal of paths) {
			if (typeof pathVal === 'string') {
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
			} catch {
				return null; // Should not happen for valid extracted JSON parts
			}
		} else {
			// Should not happen for valid JSON (e.g., bigint, symbol, function)
			return null;
		}
	}
);

// json_quote(X)
export const jsonQuoteFunc = createScalarFunction(
	{ name: 'json_quote', numArgs: 1, deterministic: true },
	(value: SqlValue): SqlValue => {
		if (value === null) return 'null';
		switch (typeof value) {
			case 'number':
				if (!Number.isFinite(value)) return 'null'; // JSON doesn't support Infinity/NaN
				return String(value);
			case 'boolean':
				return value ? 'true' : 'false';
			case 'string':
				return JSON.stringify(value); // Correctly escapes the string
			case 'bigint':
				// BigInts are not directly representable in standard JSON
				return null;
			case 'object':
				if (value instanceof Uint8Array) {
					// BLOBs cannot be represented in JSON
					return null;
				} else if (Array.isArray(value) || (value !== null && typeof value === 'object')) {
					// Handle arrays and plain objects by converting to JSON string
					try {
						return JSON.stringify(value);
					} catch {
						return null;
					}
				}
				return null;
			default:
				return null;
		}
	}
);

// json_array(X, Y, ...)
export const jsonArrayFunc = createScalarFunction(
	{ name: 'json_array', numArgs: -1, deterministic: true },
	(...args: SqlValue[]): SqlValue => {
		// Values need to be converted to valid JSON representations before stringifying
		const jsonCompatibleArgs = args.map(arg => prepareJsonValue(arg)); // Use helper
		try {
			return JSON.stringify(jsonCompatibleArgs);
		} catch {
			return null; // Should not happen with basic types
		}
	}
);

// json_object(N1, V1, N2, V2, ...)
export const jsonObjectFunc = createScalarFunction(
	{ name: 'json_object', numArgs: -1, deterministic: true },
	(...args: SqlValue[]): SqlValue => {
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
		} catch {
			return null;
		}
	}
);

// --- Additional JSON Functions --- //

// json_array_length(json, path?)
export const jsonArrayLengthFunc = createScalarFunction(
	{ name: 'json_array_length', numArgs: -1, deterministic: true },
	(json: SqlValue, path?: SqlValue): SqlValue => {
		const data = safeJsonParse(json);
		if (data === null && typeof json === 'string') return null;

		let targetValue: JSONValue | undefined = data;
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
	}
);

// json_patch(json, patch)
export const jsonPatchFunc = createScalarFunction(
	{ name: 'json_patch', numArgs: 2, deterministic: false }, // Not deterministic as patch content varies
	(json: SqlValue, patchVal: SqlValue): SqlValue => {
		const data = safeJsonParse(json);
		// JSON Patches must be JSON arrays
		const patchData = safeJsonParse(patchVal);

		if (data === null && typeof json === 'string') return null; // Invalid target JSON
		if (!Array.isArray(patchData)) return null; // Invalid patch JSON (must be array)

		// Ensure patch operations have the correct structure (basic check)
		const patch = patchData as unknown as Operation[];
		if (!patch.every(op => typeof op === 'object' && op !== null && 'op' in op && 'path' in op)) {
			return null; // Invalid operation structure
		}

		try {
			// fast-json-patch might throw on invalid patch operations or test failures
			// applyPatch mutates by default, but since `data` is freshly parsed, it's okay.
			// If data came from elsewhere, we might need deepCopyJson first.
			const result = applyPatch(data, patch, true /* validate operations */).newDocument;
			return JSON.stringify(result);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} catch (e: any) {
			errorLog('json_patch failed: %s, %O', e?.message, e);
			return null; // Return NULL on patch failure
		}
	}
);

// --- Manipulation Functions --- //

// json_insert(JSON, PATH, VALUE, PATH, VALUE, ...)
export const jsonInsertFunc = createScalarFunction(
	{ name: 'json_insert', numArgs: -1, deterministic: true },
	(json: SqlValue, ...args: SqlValue[]): SqlValue => {
		const data = safeJsonParse(json);
		if (data === null && typeof json === 'string') return null; // Invalid JSON input
		if (args.length === 0 || args.length % 2 !== 0) return null; // Need path/value pairs

		// Work on a copy
		const currentData = deepCopyJson(data);

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
				} else if (typeof parent === 'object' && parent !== null && !Array.isArray(parent) && typeof key === 'string') {
					(parent as Record<string, JSONValue>)[key] = preparedValue;
				}
				// else: Cannot insert into non-container or invalid key type - ignore
			}
			// If path *does* exist, json_insert does nothing.
		}

		try {
			return JSON.stringify(currentData);
		} catch {
			return null;
		}
	}
);

// json_replace(JSON, PATH, VALUE, PATH, VALUE, ...)
export const jsonReplaceFunc = createScalarFunction(
	{ name: 'json_replace', numArgs: -1, deterministic: true },
	(json: SqlValue, ...args: SqlValue[]): SqlValue => {
		const data = safeJsonParse(json);
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
		} catch {
			return null;
		}
	}
);

// json_set(JSON, PATH, VALUE, PATH, VALUE, ...)
export const jsonSetFunc = createScalarFunction(
	{ name: 'json_set', numArgs: -1, deterministic: true },
	(json: SqlValue, ...args: SqlValue[]): SqlValue => {
		const data = safeJsonParse(json);
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

			const { parent, key } = pathInfo;

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
		} catch {
			return null;
		}
	}
);

// json_remove(JSON, PATH, PATH, ...)
export const jsonRemoveFunc = createScalarFunction(
	{ name: 'json_remove', numArgs: -1, deterministic: true },
	(json: SqlValue, ...paths: SqlValue[]): SqlValue => {
		const data = safeJsonParse(json);
		if (data === null && typeof json === 'string') return null; // Invalid JSON input
		if (paths.length === 0) return JSON.stringify(data); // No paths means no change

		const currentData = deepCopyJson(data);

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
			} else if (typeof parent === 'object' && parent !== null && !Array.isArray(parent) && typeof key === 'string') {
				if (Object.prototype.hasOwnProperty.call(parent, key)) {
					delete (parent as Record<string, JSONValue>)[key]; // Remove object property
				}
			}
			// else: Cannot remove from non-container or invalid key type - ignore
		}

		try {
			return JSON.stringify(currentData);
		} catch {
			return null;
		}
	}
);

// --- Aggregate Functions --- //

// json_group_array(value)
export const jsonGroupArrayFunc = createAggregateFunction(
	{ name: 'json_group_array', numArgs: 1, initialValue: [] },
	(acc: any[], value: SqlValue): any[] => {
		// SQLite's json_group_array includes NULLs, unlike json_array function
		const preparedValue = prepareJsonValue(value);
		acc.push(preparedValue);
		return acc;
	},
	(acc: any[]): SqlValue => {
		try {
			// Returns NULL if the group is empty, otherwise the JSON array string
			return acc.length > 0 ? JSON.stringify(acc) : null;
		} catch {
			return null;
		}
	}
);

// json_group_object(name, value)
export const jsonGroupObjectFunc = createAggregateFunction(
	{ name: 'json_group_object', numArgs: 2, initialValue: {} },
	(acc: Record<string, any>, name: SqlValue, value: SqlValue): Record<string, any> => {
		if (name === null || name === undefined) {
			return acc; // Skip if name is NULL/undefined
		}
		// Convert the name to a string key - SQLite converts non-string keys to strings
		const stringKey = String(name);
		// SQLite's json_group_object includes NULL values associated with keys
		const preparedValue = prepareJsonValue(value);
		acc[stringKey] = preparedValue;
		return acc;
	},
	(acc: Record<string, any>): SqlValue => {
		try {
			// Returns NULL if the group is empty, otherwise the JSON object string
			return Object.keys(acc).length > 0 ? JSON.stringify(acc) : null;
		} catch {
			return null;
		}
	}
);
