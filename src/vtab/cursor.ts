import type { VirtualTable } from './table';

/**
 * Base class (or interface) representing a cursor scanning a virtual table instance.
 * Module implementations will typically subclass this.
 */
export abstract class VirtualTableCursor<TTable extends VirtualTable> {
	public readonly table: TTable; // Reference back to the table instance

	constructor(table: TTable) {
		this.table = table;
	}

	// Cursor implementations will add state properties (e.g., current position).
}
