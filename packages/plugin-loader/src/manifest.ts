/**
 * Re-export manifest types from the core @quereus/quereus package.
 *
 * All canonical type definitions live in the core package. This module
 * re-exports them so that plugin-loader consumers who import from
 * '@quereus/plugin-loader' continue to resolve the same types without
 * maintaining a duplicate set of definitions.
 */
export type {
	PluginSetting,
	VTablePluginInfo,
	FunctionPluginInfo,
	CollationPluginInfo,
	TypePluginInfo,
	PluginRegistrations,
	PluginManifest,
	PluginRecord,
} from '@quereus/quereus';
