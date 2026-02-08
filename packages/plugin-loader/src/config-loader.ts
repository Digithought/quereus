/**
 * Configuration loader for Quoomb
 * Handles loading, parsing, and interpolating quoomb.config.json files
 */

import type { Database, SqlValue } from '@quereus/quereus';
import { loadPlugin } from './plugin-loader.js';
import debug from 'debug';

const log = debug('quereus:config-loader');

/**
 * Plugin configuration from config file
 */
export interface PluginConfig {
	source: string;
	config?: Record<string, unknown>;
}

/**
 * Quoomb configuration file format
 */
export interface QuoombConfig {
	$schema?: string;
	plugins?: PluginConfig[];
	autoload?: boolean;
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/**
 * Interpolate environment variables in a value.
 * Supports ${VAR_NAME} and ${VAR_NAME:-default} syntax.
 */
export function interpolateEnvVars(value: JsonValue, env: Record<string, string> = {}): JsonValue {
	if (typeof value === 'string') {
		return value.replace(/\$\{([^}]+)\}/g, (_match, varSpec: string) => {
			const [varName, defaultValue] = varSpec.split(':-');
			return env[varName.trim()] ?? defaultValue ?? _match;
		});
	}
	if (typeof value === 'object' && value !== null) {
		if (Array.isArray(value)) {
			return value.map(v => interpolateEnvVars(v, env));
		}
		const result: Record<string, JsonValue> = {};
		for (const [key, val] of Object.entries(value)) {
			result[key] = interpolateEnvVars(val, env);
		}
		return result;
	}
	return value;
}

/**
 * Interpolate environment variables in a config object
 */
export function interpolateConfigEnvVars(config: QuoombConfig, env?: Record<string, string>): QuoombConfig {
	const envVars = env ?? buildProcessEnv();
	return interpolateEnvVars(config as unknown as JsonValue, envVars) as unknown as QuoombConfig;
}

function buildProcessEnv(): Record<string, string> {
	if (typeof process === 'undefined' || !process.env) return {};
	return Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
	);
}

/**
 * Converts a plugin config value to a SqlValue.
 * Complex types are serialized as JSON strings.
 */
function toSqlValue(value: unknown): SqlValue {
	if (value === null || value === undefined) return null;
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
	return JSON.stringify(value);
}

/**
 * Load plugins from a config object.
 * Collects all load failures and throws an aggregate error when any plugins fail.
 */
export async function loadPluginsFromConfig(
	db: Database,
	config: QuoombConfig,
	options?: { allowCdn?: boolean; env?: 'auto' | 'browser' | 'node' }
): Promise<void> {
	if (!config.plugins || config.plugins.length === 0) {
		return;
	}

	const failures: Array<{ source: string; error: Error }> = [];

	for (const pluginConfig of config.plugins) {
		try {
			const sqlConfig: Record<string, SqlValue> = {};
			for (const [key, value] of Object.entries(pluginConfig.config ?? {})) {
				sqlConfig[key] = toSqlValue(value);
			}
			await loadPlugin(pluginConfig.source, db, sqlConfig, options);
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			log('Failed to load plugin from %s: %s', pluginConfig.source, err.message);
			failures.push({ source: pluginConfig.source, error: err });
		}
	}

	if (failures.length > 0) {
		const details = failures.map(f => `  - ${f.source}: ${f.error.message}`).join('\n');
		throw new Error(
			`Failed to load ${failures.length} plugin(s):\n${details}`
		);
	}
}

/**
 * Validate a config object structure
 */
export function validateConfig(config: unknown): config is QuoombConfig {
	if (typeof config !== 'object' || config === null) return false;

	const obj = config as Record<string, unknown>;

	if (obj.plugins !== undefined) {
		if (!Array.isArray(obj.plugins)) return false;
		for (const plugin of obj.plugins) {
			if (!isValidPluginEntry(plugin)) return false;
		}
	}

	if (obj.autoload !== undefined && typeof obj.autoload !== 'boolean') return false;

	return true;
}

function isValidPluginEntry(plugin: unknown): boolean {
	if (typeof plugin !== 'object' || plugin === null) return false;
	const p = plugin as Record<string, unknown>;
	if (typeof p.source !== 'string') return false;
	if (p.config !== undefined && p.config !== null && (typeof p.config !== 'object' || Array.isArray(p.config))) return false;
	return true;
}
