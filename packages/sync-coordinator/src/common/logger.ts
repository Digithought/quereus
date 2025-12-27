/**
 * Debug logger setup for sync-coordinator.
 *
 * Uses the 'debug' library for configurable, namespace-based logging.
 */

import debug from 'debug';

const ROOT_NAMESPACE = 'sync-coordinator';

/**
 * Create a namespaced logger.
 *
 * @param namespace - Sub-namespace (e.g., 'server', 'ws', 'service')
 * @returns A debug logger function
 */
export function createLogger(namespace: string): debug.Debugger {
  return debug(`${ROOT_NAMESPACE}:${namespace}`);
}

// Pre-created loggers for common namespaces
export const serverLog = createLogger('server');
export const httpLog = createLogger('http');
export const wsLog = createLogger('ws');
export const serviceLog = createLogger('service');
export const authLog = createLogger('auth');
export const configLog = createLogger('config');

