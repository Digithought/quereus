import type { VirtualTableModule } from './module';
import type { Database } from '../core/database';
import type { TableSchema } from '../schema/table';

/**
 * Base class (or interface) representing an instance of a virtual table.
 * Module implementations will typically subclass this.
 */
export abstract class VirtualTable {
	public readonly module: VirtualTableModule<any, any>; // Reference back to the module
	public readonly db: Database; // Database connection
	public readonly tableName: string;
	public readonly schemaName: string;
	public errorMessage?: string; // For storing error messages (like C API's zErrMsg)
	public tableSchema?: TableSchema;

	constructor(db: Database, module: VirtualTableModule<any, any>, schemaName: string, tableName: string) {
		this.db = db;
		this.module = module;
		this.schemaName = schemaName;
		this.tableName = tableName;
	}

	/**
	 * Sets an error message for the VTable, freeing any previous message.
	 * Mimics the C API's zErrMsg handling.
	 * @param message The error message string.
	 */
	protected setErrorMessage(message: string | undefined): void {
		// In JS/TS, we don't need to manually free like in C with sqlite3_mprintf/sqlite3_free.
		// Just assign the new message. If it's undefined, the error state is cleared.
		this.errorMessage = message;
	}

	// VTable implementations will add specific properties and methods.
}
