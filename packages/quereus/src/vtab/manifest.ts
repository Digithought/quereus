/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SqlValue } from '../common/types.js';
import type { FunctionSchema } from '../schema/function.js';
import type { CollationFunction } from '../util/comparison.js';

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
 * Virtual table module registration info
 */
export interface VTablePluginInfo {
	name: string;                   // module name for registration
	module: any;                   // the VirtualTableModule implementation
	auxData?: unknown;             // optional auxiliary data
}

/**
 * Function registration info
 */
export interface FunctionPluginInfo {
	schema: FunctionSchema;        // complete function schema
}

/**
 * Collation registration info
 */
export interface CollationPluginInfo {
	name: string;                  // collation name
	func: CollationFunction;       // comparison function
}

/**
 * Plugin registration items - what the plugin wants to register
 */
export interface PluginRegistrations {
	vtables?: VTablePluginInfo[];
	functions?: FunctionPluginInfo[];
	collations?: CollationPluginInfo[];
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
	
	// Plugin type indicators (for UI display)
	provides?: {
		vtables?: string[];         // names of vtable modules provided
		functions?: string[];       // names of functions provided
		collations?: string[];      // names of collations provided
	};
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
