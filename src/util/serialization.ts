/**
 * Utility functions for safe serialization, particularly handling BigInt and Uint8Arrays.
 */

export function jsonStringify(obj: any, space?: string | number): string {
  return JSON.stringify(
		obj,
		(_, value) => {
			if (typeof value === 'bigint') {
				// Convert to number if it's within safe integer limits for JSON
				if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
					return Number(value);
				}
				// Otherwise, convert to string (without 'n' suffix for standard JSON)
				return value.toString();
			} else if (value instanceof Uint8Array) {
				return `0x${Buffer.from(value).toString('hex')}`; // Keep existing Uint8Array handling
			}
			return value;
		},
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
