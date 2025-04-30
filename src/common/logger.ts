import debug from 'debug';

// Base namespace for the project
const BASE_NAMESPACE = 'sqliter';

/**
 * Creates a namespaced debug logger instance.
 *
 * Example: createLogger('compiler') -> returns a debugger for 'sqliter:compiler'
 * Example: createLogger('vtab:memory') -> returns a debugger for 'sqliter:vtab:memory'
 *
 * Usage:
 * const log = createLogger('compiler');
 * log('Compiling statement: %s', sql);
 * const errorLog = log.extend('error'); // Creates 'sqliter:compiler:error'
 * errorLog('Compilation failed: %O', error);
 *
 * @param subNamespace The specific subsystem namespace (e.g., 'parser', 'vdbe:runtime', 'vtab:memory')
 * @returns A debug instance.
 */
export function createLogger(subNamespace: string): debug.Debugger {
  return debug(`${BASE_NAMESPACE}:${subNamespace}`);
}
