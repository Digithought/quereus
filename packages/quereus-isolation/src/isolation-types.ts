import type { VirtualTableModule, VirtualTable } from '@quereus/quereus';

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

/**
 * Internal state for an isolated table instance.
 */
export interface IsolatedTableState {
	/** The wrapped underlying table */
	underlyingTable: VirtualTable;

	/** The overlay table storing uncommitted changes */
	overlayTable: VirtualTable;

	/** Whether there are any pending changes in the overlay */
	hasChanges: boolean;

	/** Current savepoint depth */
	savepointDepth: number;
}
