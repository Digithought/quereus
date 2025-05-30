import { createLogger } from '../../../common/logger.js';
import { safeJsonStringify } from '../../../util/serialization.js';

/**
 * Creates consistent logging utilities for memory vtable components
 */
export function createMemoryTableLoggers(namespace: string) {
	const log = createLogger(`vtab:memory:${namespace}`);

	const warnLog = log.extend('warn');
	const errorLog = log.extend('error');
	const debugLog = log.extend('debug');

	return {
		info: log,
		warnLog,
		errorLog,
		debugLog,

		operation: (operation: string, tableName: string, details?: any) => {
			log(`[${tableName}] ${operation}${details ? `: ${safeJsonStringify(details)}` : ''}`);
		},

		warn: (operation: string, tableName: string, message: string, details?: any) => {
			warnLog(`[${tableName}] ${operation}: ${message}${details ? ` - ${safeJsonStringify(details)}` : ''}`);
		},

		error: (operation: string, tableName: string, innerError: unknown, details?: any) => {
			const errorMessage = innerError instanceof Error ? innerError.message : innerError;
			errorLog(`[${tableName}] ${operation} failed: ${errorMessage}${details ? ` - ${safeJsonStringify(details)}` : ''}`);
		},
	};
}
