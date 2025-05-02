/**
 * Utility functions for safe serialization, particularly handling BigInt and Uint8Arrays.
 */

export function jsonStringify(obj: any, space?: string | number): string {
  return JSON.stringify(
		obj,
		(_, value) =>
			typeof value === 'bigint'
				? value.toString() + 'n' // Represent BigInts as strings suffixed with 'n'
				: value instanceof Uint8Array
				? `0x${Buffer.from(value).toString('hex')}`
				: value,
		space
	);
}

/**
 * Safely stringifies an object to JSON, converting BigInts to strings
 * ending with 'n' to avoid serialization errors.
 *
 * @param obj The object to stringify.
 * @param space Optional spacing argument for JSON.stringify.
 * @returns JSON string representation.
 */
export function safeJsonStringify(obj: any, space?: string | number): string {
  try {
    return jsonStringify(obj, space);
  } catch (e) {
    // Fallback in case of unexpected stringify errors
    console.error("safeJsonStringify failed:", e);
    return `[Unserializable Object: ${e instanceof Error ? e.message : String(e)}]`;
  }
}
