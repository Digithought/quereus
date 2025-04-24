import type { VirtualTable } from './table';
import type { SqliteContext } from '../func/context';
import { StatusCode, type SqlValue } from '../common/types';

/**
 * Base class (or interface) for virtual table cursors.
 * Module implementations will typically subclass this.
 */
export abstract class VirtualTableCursor<T extends VirtualTable> {
	public readonly table: T; // Reference back to the table instance

	constructor(table: T) {
		this.table = table;
	}

	// Cursor methods are implemented in the module.ts file
	// TODO: eventually move them here to support js idioms
}
