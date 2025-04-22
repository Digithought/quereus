import type { SqlValue } from '../../common/types';

/** Safely parses a JSON string into a JS value, returning null on error. */
export function safeJsonParse(jsonString: SqlValue): any | null {
	if (typeof jsonString !== 'string') {
		return null;
	}
	try {
		return JSON.parse(jsonString);
	} catch (e) {
		return null;
	}
}

/**
 * Parses a JSON path and returns information needed for modification.
 * Optionally creates intermediate objects/arrays for `json_set`.
 * @returns Object with { parent, key, value, exists: boolean } or null if path is invalid.
 *          `parent`: The object/array containing the target.
 *          `key`: The final key/index in the path.
 *          `value`: The value at the path (if it exists).
 *          `exists`: Whether the path fully resolved to a value.
 */
export function resolveJsonPathForModify(
	data: any,
	path: string,
	createParents: boolean = false // Flag for json_set behavior
): { parent: any; key: string | number; value: any; exists: boolean } | null {
	if (!path || typeof path !== 'string') return null;

	let current = data;
	let parent: any = null;
	let finalKey: string | number | null = null;
	let remainingPath = path.startsWith('$') ? path.substring(1) : path;

	if (remainingPath === '') {
		// Path is just '$', target is the root
		return { parent: null, key: '', value: data, exists: true };
	}

	while (remainingPath.length > 0) {
		parent = current;
		finalKey = null;

		if (current === undefined || current === null) return null; // Cannot traverse undefined/null

		if (remainingPath.startsWith('.')) {
			remainingPath = remainingPath.substring(1);
			let keyStr: string; // Declare key type explicitly
			if (remainingPath.startsWith('"')) {
				const endQuote = remainingPath.indexOf('"', 1);
				if (endQuote === -1) return null; // Invalid path
				keyStr = remainingPath.substring(1, endQuote);
				remainingPath = remainingPath.substring(endQuote + 1);
			} else {
				const match = remainingPath.match(/^([^[.\\s]+)/);
				if (!match) return null; // Invalid path
				keyStr = match[1];
				remainingPath = remainingPath.substring(keyStr.length);
			}
			if (typeof current !== 'object' || Array.isArray(current)) {
				// Path failure unless we are creating parents
				if (!createParents || typeof parent !== 'object' || parent === null || Array.isArray(parent) || typeof finalKey !== 'string') {
					return { parent, key: keyStr, value: undefined, exists: false };
				}
				// Create the missing parent object
				console.debug(`JSON Path: Creating intermediate object for key "${finalKey}"`);
				parent[finalKey] = {};
				current = parent[finalKey]; // Continue traversal from the new object
				parent = current; // The new object becomes the parent for the next step
				// Re-evaluate the current segment against the newly created object
				finalKey = keyStr;
				current = current[keyStr]; // This will be undefined initially
			} else {
				// Parent is an object, proceed normally
				finalKey = keyStr;
				current = current[keyStr];
			}

		} else if (remainingPath.startsWith('[')) {
			const endBracket = remainingPath.indexOf(']');
			if (endBracket === -1) return null; // Invalid path
			const indexStr = remainingPath.substring(1, endBracket).trim();
			const index = parseInt(indexStr, 10);
			remainingPath = remainingPath.substring(endBracket + 1);

			if (!Number.isInteger(index) || index < 0) return null; // Invalid index

			if (!Array.isArray(current)) {
				// Path failure unless we are creating parents
				if (!createParents || parent === null || typeof finalKey === null) {
					return { parent, key: index, value: undefined, exists: false };
				}
				// Create the missing parent array
				let newParentArray: any[] = [];
				if (Array.isArray(parent) && typeof finalKey === 'number') {
					console.debug(`JSON Path: Creating intermediate array for index ${finalKey}`);
					parent[finalKey] = newParentArray;
				} else if (typeof parent === 'object' && !Array.isArray(parent) && typeof finalKey === 'string') {
					console.debug(`JSON Path: Creating intermediate array for key "${finalKey}"`);
					parent[finalKey] = newParentArray;
				} else {
					// Cannot create parent array in this context
					return { parent, key: index, value: undefined, exists: false };
				}
				current = newParentArray; // Continue traversal from the new array
				parent = current; // The new array becomes the parent
				// Re-evaluate the current segment ([index]) against the new array
				finalKey = index;
				current = index < current.length ? current[index] : undefined;
			} else {
				// Parent is an array, proceed normally
				finalKey = index;
				current = index < current.length ? current[index] : undefined;
			}
		} else {
			return null; // Invalid path segment
		}
	}

	// Path successfully traversed
	if (finalKey === null) return null; // Should have a final key unless path was just '$'
	return { parent, key: finalKey, value: current, exists: current !== undefined };
}

/** Converts SQL value to JSON-compatible value for insertion/setting */
export function prepareJsonValue(value: SqlValue): any {
	if (typeof value === 'bigint') {
		// Represent BigInt as Number if safe, otherwise maybe string or error?
		// SQLite likely stores as number if possible.
		if (value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER) {
			return Number(value);
		}
		// Outside safe range - return as string? Or null?
		return value.toString(); // String representation for large BigInts
	}
	if (value instanceof Uint8Array) {
		return null; // Blobs cannot be represented
	}
	if (typeof value === 'number' && !Number.isFinite(value)) {
		return null; // NaN/Infinity cannot be represented
	}
	// Check if string looks like JSON itself
	if (typeof value === 'string') {
		try {
			// Attempt to parse, if successful, use the parsed object/array/primitive
			// This allows inserting pre-formed JSON objects/arrays.
			return JSON.parse(value);
		} catch (e) {
			// It's just a regular string
			return value;
		}
	}
	return value; // null, boolean, safe numbers are returned as is
}

/** Deep copies JSON-compatible data (objects, arrays, primitives) */
export function deepCopyJson(data: any): any {
	if (data === null || typeof data !== 'object') {
		return data; // Primitives are immutable
	}
	if (Array.isArray(data)) {
		return data.map(deepCopyJson);
	}
	const copy: Record<string, any> = {};
	for (const key in data) {
		if (Object.prototype.hasOwnProperty.call(data, key)) {
			copy[key] = deepCopyJson(data[key]);
		}
	}
	return copy;
}

/** Determines the SQLite JSON type name for a JS value */
export function getJsonType(value: any): string {
	if (value === null) return 'null';
	switch (typeof value) {
		case 'boolean': return value ? 'true' : 'false';
		case 'number': return Number.isInteger(value) ? 'integer' : 'real';
		case 'string': return 'text';
		case 'object':
			if (Array.isArray(value)) return 'array';
			return 'object';
		default: return 'null'; // Should not happen for valid JSON
	}
}

/** Basic JSON Path evaluation - less robust than resolveJsonPathForModify */
export function evaluateJsonPathBasic(data: any, path: string): any | undefined {
	if (!path || path === '$') return data;
	// Basic path splitting, doesn't handle quoted keys or complex array access well
	const parts = path.startsWith('$.') ? path.substring(2).split('.') :
					path.startsWith('$') ? path.substring(1).split('.') :
					path.split('.');

	let current = data;
	for (const part of parts) {
		if (current === null || current === undefined) return undefined;

		// Very basic array index check
		const arrayMatch = part.match(/^\s*\[(\d+)\]\s*$/);
		if (arrayMatch) {
			const index = parseInt(arrayMatch[1], 10);
			if (Array.isArray(current) && index >= 0 && index < current.length) {
				current = current[index];
			} else {
				return undefined; // Cannot index non-array or out of bounds
			}
		} else if (typeof current === 'object' && current !== null && Object.prototype.hasOwnProperty.call(current, part)) {
			current = current[part]; // Simple key access
		} else {
			return undefined;
		}
	}
	return current;
}
