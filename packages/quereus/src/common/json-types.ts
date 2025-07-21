/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Represents a JSON-compatible value structure
 *
 * This type represents the valid JSON value space that can result from
 * JSON.parse() or be passed to JSON.stringify(). It excludes JavaScript
 * values that cannot be represented in JSON (undefined, functions, symbols, etc.)
 */
export type JSONValue =
	| string
	| number
	| boolean
	| null
	| JSONValue[]
	| { [key: string]: JSONValue };
/* eslint-enable @typescript-eslint/no-explicit-any */
