/**
 * Configuration loader for Quoomb
 * Handles loading, parsing, and interpolating quoomb.config.json files
 */

import type { Database, SqlValue } from '@quereus/quereus';
import { loadPlugin } from './plugin-loader.js';

/**
 * Plugin configuration from config file
 */
export interface PluginConfig {
  source: string;
  config?: Record<string, any>;
}

/**
 * Quoomb configuration file format
 */
export interface QuoombConfig {
  $schema?: string;
  plugins?: PluginConfig[];
  autoload?: boolean;
}

/**
 * Interpolate environment variables in a value
 * Supports ${VAR_NAME} and ${VAR_NAME:-default} syntax
 */
export function interpolateEnvVars(value: any, env: Record<string, string> = {}): any {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (match, varSpec) => {
      const [varName, defaultValue] = varSpec.split(':-');
      return env[varName.trim()] ?? defaultValue ?? match;
    });
  }
  if (typeof value === 'object' && value !== null) {
    if (Array.isArray(value)) {
      return value.map(v => interpolateEnvVars(v, env));
    }
    const result: Record<string, any> = {};
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
  let envVars: Record<string, string> = {};

  if (env) {
    envVars = env;
  } else if (typeof process !== 'undefined' && process.env) {
    // Filter out undefined values from process.env
    envVars = Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined) as Array<[string, string]>
    );
  }

  return interpolateEnvVars(config, envVars);
}

/**
 * Load plugins from a config object
 */
export async function loadPluginsFromConfig(
  db: Database,
  config: QuoombConfig,
  options?: { allowCdn?: boolean; env?: 'auto' | 'browser' | 'node' }
): Promise<void> {
  if (!config.plugins || config.plugins.length === 0) {
    return;
  }

  for (const pluginConfig of config.plugins) {
    try {
      const configObj = pluginConfig.config ?? {};

      // Convert config values to SqlValue type
      const sqlConfig: Record<string, SqlValue> = {};
      for (const [key, value] of Object.entries(configObj)) {
        if (value === null || value === undefined) {
          sqlConfig[key] = null;
        } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          sqlConfig[key] = value;
        } else {
          // For complex types, convert to JSON string
          sqlConfig[key] = JSON.stringify(value);
        }
      }

      await loadPlugin(pluginConfig.source, db, sqlConfig, options);
    } catch (error) {
      console.warn(
        `Warning: Failed to load plugin from ${pluginConfig.source}: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }
}

/**
 * Validate a config object
 */
export function validateConfig(config: any): config is QuoombConfig {
  if (typeof config !== 'object' || config === null) {
    return false;
  }

  if (config.plugins !== undefined) {
    if (!Array.isArray(config.plugins)) {
      return false;
    }
    for (const plugin of config.plugins) {
      if (typeof plugin !== 'object' || plugin === null) {
        return false;
      }
      if (typeof plugin.source !== 'string') {
        return false;
      }
      if (plugin.config !== undefined && typeof plugin.config !== 'object') {
        return false;
      }
    }
  }

  if (config.autoload !== undefined && typeof config.autoload !== 'boolean') {
    return false;
  }

  return true;
}

