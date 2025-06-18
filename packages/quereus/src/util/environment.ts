/**
 * Cross-platform environment variable utilities
 * Works in Node.js, browsers, and React Native
 */

import { createLogger } from '../common/logger.js';

/**
 * Cross-platform environment variable accessor
 * Works in Node.js, browsers, and React Native
 *
 * @param key The environment variable name
 * @returns The environment variable value or undefined if not found
 */
export function getEnvVar(key: string): string | undefined {
	// Node.js environment
	if (typeof process !== 'undefined' && process.env) {
		return process.env[key];
	}

	// Browser environment - check if globalThis has the variable
	// This allows setting environment variables like: globalThis.DEBUG = "quereus:*"
	if (typeof globalThis !== 'undefined' && (globalThis as any)[key]) {
		return (globalThis as any)[key];
	}

	// React Native or other environments might set environment variables differently
	// For now, return undefined for unsupported environments
	return undefined;
}

/**
 * Check if debug logging is enabled for a specific namespace
 * Uses the debug library's own enabled property via createLogger
 *
 * @param namespace The debug namespace to check (without the 'quereus:' prefix)
 * @returns true if debug logging is enabled for the namespace
 */
export function isDebugEnabled(namespace: string): boolean {
	const logger = createLogger(namespace);
	return logger.enabled;
}

/**
 * Check if a feature flag is enabled
 *
 * @param flagName The feature flag name
 * @returns true if the flag is set to 'true'
 */
export function isFeatureEnabled(flagName: string): boolean {
	return getEnvVar(flagName) === 'true';
}
