import type { VirtualTableModule } from '@quereus/quereus';

/**
 * Configuration for creating an isolation-wrapped module.
 */
export interface IsolationModuleConfig {
	/**
	 * The module to wrap with isolation semantics.
	 */
	underlying: VirtualTableModule<any, any>;

	/**
	 * Module to use for overlay storage (uncommitted changes).
	 * Defaults to memory vtab if not specified.
	 */
	overlay?: VirtualTableModule<any, any>;

	/**
	 * Column name to use for tombstone marker in overlay tables.
	 * Defaults to '_tombstone'.
	 */
	tombstoneColumn?: string;
}
