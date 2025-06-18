import { createLogger } from '../common/logger.js';

const log = createLogger('util:patterns');
const errorLog = log.extend('error');

/**
 * Simple LIKE pattern matching implementation.
 * Supports SQL LIKE patterns:
 * - % matches any sequence of characters (including empty sequence)
 * - _ matches any single character
 *
 * @param pattern The LIKE pattern
 * @param text The text to match against
 * @returns true if the text matches the pattern, false otherwise
 */
export function simpleLike(pattern: string, text: string): boolean {
	// Escape regex special characters except % and _
	const escapedPattern = pattern.replace(/[.*+^${}()|[\]\\]/g, '\\$&');
	// Convert SQL LIKE wildcards to regex equivalents
	const regexPattern = escapedPattern.replace(/%/g, '.*').replace(/_/g, '.');

	try {
		const regex = new RegExp(`^${regexPattern}$`);
		return regex.test(text);
	} catch (e) {
		errorLog('Invalid LIKE pattern converted to regex: ^%s$, %O', regexPattern, e);
		return false;
	}
}

/**
 * Simple GLOB pattern matching implementation.
 * Supports SQL GLOB patterns:
 * - * matches any sequence of characters (including empty sequence)
 * - ? matches any single character
 *
 * @param pattern The GLOB pattern
 * @param text The text to match against
 * @returns true if the text matches the pattern, false otherwise
 */
export function simpleGlob(pattern: string, text: string): boolean {
	// Escape regex special characters except * and ?
	const escapedPattern = pattern.replace(/[.*+^${}()|[\]\\]/g, '\\$&');
	// Convert SQL GLOB wildcards to regex equivalents
	const regexPattern = escapedPattern
		.replace(/\\\*/g, '.*')
		.replace(/\\\?/g, '.');

	try {
		const regex = new RegExp(`^${regexPattern}$`);
		return regex.test(text);
	} catch (e) {
		errorLog('Invalid GLOB pattern converted to regex: ^%s$, %O', regexPattern, e);
		return false;
	}
}
