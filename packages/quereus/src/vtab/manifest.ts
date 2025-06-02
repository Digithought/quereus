import type { SqlValue } from '../common/types.js';

/**
 * Configuration setting definition for a plugin
 */
export interface PluginSetting {
	key: string;                    // "path"
	label: string;                  // "JSON Path"
	type: 'string' | 'number' | 'boolean' | 'select';
	default?: SqlValue;
	options?: SqlValue[];           // for select type
	help?: string;
}

/**
 * Plugin manifest that describes the plugin's metadata and configuration options
 */
export interface PluginManifest {
	name: string;                   // "JSON_TABLE"
	version: string;                // "1.0.0"
	author?: string;
	description?: string;
	pragmaPrefix?: string;          // default = name, used for PRAGMA commands
	settings?: PluginSetting[];     // configuration options
	capabilities?: string[];        // e.g. ['scan', 'index', 'write']
}

/**
 * Plugin record used for persistence across sessions
 */
export interface PluginRecord {
	id: string;                     // UUID for this installation
	url: string;                    // Full URL to the ES module
	enabled: boolean;               // Whether to load at startup
	manifest?: PluginManifest;      // Cached after first successful load
	config: Record<string, SqlValue>; // User-configured values
}
