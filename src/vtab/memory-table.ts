import { VirtualTable } from './table';
import { VirtualTableCursor } from './cursor';
import type { VirtualTableModule } from './module';
import type { IndexInfo, IndexConstraint } from './indexInfo';
import { IndexConstraintOp } from '../common/constants';
import type { Database } from '../core/database';
import { type SqlValue, StatusCode, SqlDataType } from '../common/types';
import { SqliteError, ConstraintError } from '../common/errors';
import type { SqliteContext } from '../func/context';
import { Latches } from '../util/latches';

/**
 * Simple cursor for the MemoryTable
 */
class MemoryTableCursor extends VirtualTableCursor<MemoryTable> {
    /** Current position in the data array (-1 for not positioned) */
    private position: number = -1;
    /** Filtered rows for the current query */
    private filteredRows: number[] = [];
    /** Track if we've reached EOF */
    private isEof: boolean = true;

    constructor(table: MemoryTable) {
        super(table);
    }

    /** Reset the cursor */
    reset(): void {
        this.position = -1;
        this.filteredRows = [];
        this.isEof = true;
    }

    /** Get the current row data if positioned */
    getCurrentRow(): Record<string, SqlValue> | null {
        if (this.position < 0 || this.position >= this.filteredRows.length) {
            return null;
        }
        return this.table.getRowByIndex(this.filteredRows[this.position]);
    }

    /** Get current row index in the base table */
    getCurrentRowIndex(): number {
        if (this.position < 0 || this.position >= this.filteredRows.length) {
            return -1;
        }
        return this.filteredRows[this.position];
    }

    /** Set the filter results */
    setFilteredRows(rows: number[]): void {
        this.filteredRows = rows;
        this.position = -1;
        this.isEof = this.filteredRows.length === 0;
    }

    /** Advance to next position */
    advance(): void {
        if (this.position < this.filteredRows.length) {
            this.position++;
        }
        this.isEof = this.position >= this.filteredRows.length;
    }

    /** Check if at EOF */
    eof(): boolean {
        return this.isEof;
    }
}

/**
 * A simple in-memory table implementation.
 * Stores data as an array of records with a simple rowid-based index.
 */
export class MemoryTable extends VirtualTable {
    /** Column definitions */
    public columns: { name: string, type: SqlDataType }[] = [];
    /** Primary key column name (if specified) */
    private primaryKey: string | null = null;
    /** Internal data storage (rowid -> row data) */
    private data: Map<bigint, Record<string, SqlValue>> = new Map();
    /** Next available rowid */
    private nextRowid: bigint = BigInt(1);
    /** Flag indicating whether the table is read-only */
    private readOnly: boolean;

    constructor(
        db: Database,
        module: VirtualTableModule<any, any>,
        schemaName: string,
        tableName: string,
        readOnly: boolean = false
    ) {
        super(db, module, schemaName, tableName);
        this.readOnly = readOnly;
    }

    /** Set column definitions */
    setColumns(columns: { name: string, type: SqlDataType }[], primaryKey: string | null = null): void {
        this.columns = [...columns];
        this.primaryKey = primaryKey;
    }

    /** Get row by internal index */
    getRowByIndex(index: number): Record<string, SqlValue> | null {
        // Convert index to rowid and fetch
        const rowids = Array.from(this.data.keys());
        if (index < 0 || index >= rowids.length) return null;
        return this.data.get(rowids[index]) || null;
    }

    /** Get row by rowid */
    getRow(rowid: bigint): Record<string, SqlValue> | null {
        return this.data.get(rowid) || null;
    }

    /** Add a new row with auto-assigned rowid */
    addRow(row: Record<string, SqlValue>): bigint {
        // Check primary key constraint if applicable
        if (this.primaryKey && this.primaryKey in row) {
            const pkValue = row[this.primaryKey];
            // Check for duplicates
            for (const [, existingRow] of this.data) {
                if (existingRow[this.primaryKey] === pkValue) {
                    throw new ConstraintError(`Primary key constraint violation on column '${this.primaryKey}'`);
                }
            }
        }

        // Assign rowid and store
        const rowid = this.nextRowid;
        this.data.set(rowid, {...row});
        this.nextRowid = this.nextRowid + BigInt(1);
        return rowid;
    }

    /** Update a row by rowid */
    updateRow(rowid: bigint, newData: Record<string, SqlValue>): boolean {
        const existingRow = this.data.get(rowid);
        if (!existingRow) return false;

        // Check primary key constraint if updating PK
        if (this.primaryKey && this.primaryKey in newData) {
            const pkValue = newData[this.primaryKey];
            // Check for duplicates (except self)
            for (const [rid, row] of this.data) {
                if (rid !== rowid && row[this.primaryKey] === pkValue) {
                    throw new ConstraintError(`Primary key constraint violation on column '${this.primaryKey}'`);
                }
            }
        }

        // Update row data
        this.data.set(rowid, {...existingRow, ...newData});
        return true;
    }

    /** Delete a row by rowid */
    deleteRow(rowid: bigint): boolean {
        return this.data.delete(rowid);
    }

    /** Clear all rows */
    clear(): void {
        this.data.clear();
        this.nextRowid = BigInt(1);
    }

    /** Get row count */
    get size(): number {
        return this.data.size;
    }

    /** Return all rowids */
    getRowIds(): bigint[] {
        return Array.from(this.data.keys());
    }

    /** Return all rows */
    getAllRows(): Record<string, SqlValue>[] {
        return Array.from(this.data.values());
    }

    /** Check if table is read-only */
    isReadOnly(): boolean {
        return this.readOnly;
    }
}

/**
 * A module that provides in-memory table functionality.
 */
export class MemoryTableModule implements VirtualTableModule<MemoryTable, MemoryTableCursor> {
    private static SCHEMA_VERSION = 1;

    /** A map of created memory tables (primarily for xConnect access) */
    private tables: Map<string, MemoryTable> = new Map();

    /** Module configuration */
    private config: {
        readOnly?: boolean;
    };

    constructor(config: { readOnly?: boolean } = {}) {
        this.config = config;
    }

    // Virtual table lifecycle management

    async xCreate(db: Database, pAux: unknown, args: ReadonlyArray<string>): Promise<MemoryTable> {
        if (args.length < 3) {
            throw new SqliteError("Invalid memory table declaration", StatusCode.ERROR);
        }

        const schemaName = args[1];
        const tableName = args[2];
        const tableKey = this.getTableKey(schemaName, tableName);

        // Check if already exists
        if (this.tables.has(tableKey)) {
            throw new SqliteError(`Memory table '${tableName}' already exists in schema '${schemaName}'`, StatusCode.ERROR);
        }

        // Extract column definitions from args or CREATE TABLE statement
        let createTable = "";
        if (args.length > 3) {
            // Look for explicit CREATE TABLE statement
            for (let i = 3; i < args.length; i++) {
                if (args[i].trim().toUpperCase().startsWith("CREATE TABLE")) {
                    createTable = args[i];
                    break;
                }
            }
        }

        // Create new table
        const table = new MemoryTable(db, this, schemaName, tableName, !!this.config.readOnly);
        this.tables.set(tableKey, table);

        // Generate/parse schema
        if (createTable) {
            // Real implementation would parse CREATE TABLE statement
            // For now, send back to DB to parse via declareVtab
            await this.setupSchema(db, table, createTable);
        } else {
            // Default empty schema
            const defaultCreate = `CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY, value TEXT)`;
            await this.setupSchema(db, table, defaultCreate);

            // Set up simple default columns
            table.setColumns([
                { name: 'id', type: SqlDataType.INTEGER },
                { name: 'value', type: SqlDataType.TEXT }
            ], 'id');
        }

        return table;
    }

    async xConnect(db: Database, pAux: unknown, args: ReadonlyArray<string>): Promise<MemoryTable> {
        if (args.length < 3) {
            throw new SqliteError("Invalid memory table connection request", StatusCode.ERROR);
        }

        const schemaName = args[1];
        const tableName = args[2];
        const tableKey = this.getTableKey(schemaName, tableName);

        // Check if exists
        const existingTable = this.tables.get(tableKey);
        if (existingTable) {
            return existingTable;
        }

        // If not found, create new (should mimic xCreate behavior)
        return this.xCreate(db, pAux, args);
    }

    async xDisconnect(table: MemoryTable): Promise<void> {
        // No persistent resources to clean up for in-memory tables
        // Just log the disconnect
        console.log(`Memory table '${table.tableName}' in schema '${table.schemaName}' disconnected`);
    }

    async xDestroy(table: MemoryTable): Promise<void> {
        // Remove the table from our registry
        const tableKey = this.getTableKey(table.schemaName, table.tableName);
        this.tables.delete(tableKey);
        console.log(`Memory table '${table.tableName}' in schema '${table.schemaName}' destroyed`);
    }

    // Query planning and execution

    xBestIndex(table: MemoryTable, indexInfo: IndexInfo): number {
        let hasUsableConstraints = false;
        let cost = 1000.0; // Base cost for full scan
        let estimatedRows = BigInt(table.size || 100);

        // Check for usable constraints and adjust cost/row estimates
        for (let i = 0; i < indexInfo.nConstraint; i++) {
            const constraint = indexInfo.aConstraint[i];
            if (constraint.usable) {
                // Mark as used in filter
                indexInfo.aConstraintUsage[i].argvIndex = i + 1; // 1-based
                indexInfo.aConstraintUsage[i].omit = false; // Still need verification

                if (constraint.op === IndexConstraintOp.EQ) {
                    // Equality is most selective
                    cost *= 0.1;
                    estimatedRows = BigInt(1); // Approximate for unique index
                    hasUsableConstraints = true;
                } else if (
                    constraint.op === IndexConstraintOp.GT ||
                    constraint.op === IndexConstraintOp.GE ||
                    constraint.op === IndexConstraintOp.LT ||
                    constraint.op === IndexConstraintOp.LE
                ) {
                    // Range queries still provide some selectivity
                    cost *= 0.3;
                    estimatedRows = estimatedRows / BigInt(3);
                    hasUsableConstraints = true;
                }
            }
        }

        // Set output values
        indexInfo.estimatedCost = cost;
        indexInfo.estimatedRows = estimatedRows;
        indexInfo.idxNum = hasUsableConstraints ? 1 : 0; // Simple flag for "has constraints"
        indexInfo.idxStr = null; // No complex index info needed for this simple module
        indexInfo.orderByConsumed = false; // We don't optimize for ORDER BY yet

        return StatusCode.OK;
    }

    // Cursor operations

    async xOpen(table: MemoryTable): Promise<MemoryTableCursor> {
        // Create a new cursor for this table
        return new MemoryTableCursor(table);
    }

    async xClose(cursor: MemoryTableCursor): Promise<void> {
        // Reset the cursor state
        cursor.reset();
    }

    async xFilter(
        cursor: MemoryTableCursor,
        idxNum: number,
        idxStr: string | null,
        args: ReadonlyArray<SqlValue>
    ): Promise<void> {
        // Reset cursor state
        cursor.reset();

        // Get all potential rows
        const table = cursor.table;
        const rowIndices: number[] = [];
        const allRowIds = table.getRowIds();

        // If we have constraints, apply them
        if (idxNum === 1 && args.length > 0) {
            // Process each row against constraints
            for (let i = 0; i < allRowIds.length; i++) {
                const rowid = allRowIds[i];
                const row = table.getRow(rowid);
                if (!row) continue;

                // Simple approach: check all constraints
                // A real implementation would be more sophisticated
                let matches = true;
                for (let j = 0; j < args.length && matches; j++) {
                    // This is a simplified approach - real implementations
                    // would have complex mapping between constraints and filters
                    // NOTE: This assumes the constraint order matches column order
                    const columnName = table.columns[j]?.name;
                    if (!columnName) continue;

                    const rowValue = row[columnName];
                    const argValue = args[j];

                    // Simple equality check
                    if (rowValue !== argValue) {
                        matches = false;
                    }
                }

                if (matches) {
                    rowIndices.push(i);
                }
            }
        } else {
            // No constraints, return all rows
            for (let i = 0; i < allRowIds.length; i++) {
                rowIndices.push(i);
            }
        }

        // Set filtered rows
        cursor.setFilteredRows(rowIndices);
    }

    async xNext(cursor: MemoryTableCursor): Promise<void> {
        cursor.advance();
    }

    async xEof(cursor: MemoryTableCursor): Promise<boolean> {
        return cursor.eof();
    }

    xColumn(cursor: MemoryTableCursor, context: SqliteContext, columnIndex: number): number {
        const row = cursor.getCurrentRow();
        if (!row) {
            context.resultNull();
            return StatusCode.ERROR;
        }

        // Get column name
        const columnName = cursor.table.columns[columnIndex]?.name;
        if (!columnName) {
            context.resultNull();
            return StatusCode.ERROR;
        }

        // Get column value
        const value = row[columnName];
        context.resultValue(value);
        return StatusCode.OK;
    }

    async xRowid(cursor: MemoryTableCursor): Promise<bigint> {
        const rowIndex = cursor.getCurrentRowIndex();
        if (rowIndex < 0) {
            throw new SqliteError("Invalid cursor position", StatusCode.ERROR);
        }

        const rowids = cursor.table.getRowIds();
        return rowids[rowIndex];
    }

    async xUpdate(
        table: MemoryTable,
        values: SqlValue[],
        rowid: bigint | null
    ): Promise<{ rowid?: bigint }> {
        // Check if table is read-only
        if (table.isReadOnly()) {
            throw new SqliteError(`Table '${table.tableName}' is read-only`, StatusCode.READONLY);
        }

        // Get mutex for this table
        const release = await Latches.acquire(`MemoryTable.xUpdate:${table.schemaName}.${table.tableName}`);

        try {
            if (values.length === 0) {
                throw new SqliteError("Invalid update values", StatusCode.ERROR);
            }

            if (rowid === null && values[0] === null) {
                // INSERT with automatic rowid
                const rowData: Record<string, SqlValue> = {};
                for (let i = 1; i < values.length; i++) {
                    const columnName = table.columns[i - 1]?.name;
                    if (columnName) {
                        rowData[columnName] = values[i];
                    }
                }

                const newRowid = table.addRow(rowData);
                return { rowid: newRowid };
            }
            else if (rowid !== null && values.length === 1) {
                // DELETE
                const deleted = table.deleteRow(rowid);
                if (!deleted) {
                    throw new SqliteError(`Row with rowid ${rowid} not found`, StatusCode.ERROR);
                }
                return {};
            }
            else if (rowid !== null) {
                // UPDATE
                const rowData: Record<string, SqlValue> = {};
                for (let i = 1; i < values.length; i++) {
                    const columnName = table.columns[i - 1]?.name;
                    if (columnName) {
                        rowData[columnName] = values[i];
                    }
                }

                const updated = table.updateRow(rowid, rowData);
                if (!updated) {
                    throw new SqliteError(`Row with rowid ${rowid} not found`, StatusCode.ERROR);
                }
                return {};
            }

            throw new SqliteError("Unsupported operation in xUpdate", StatusCode.ERROR);
        }
        finally {
            release();
        }
    }

    // Optional transaction methods
    async xBegin(table: MemoryTable): Promise<void> {
        // For in-memory, this can be a no-op or lock acquisition
        console.log(`Memory table '${table.tableName}' transaction begin`);
    }

    async xCommit(table: MemoryTable): Promise<void> {
        // For in-memory, this can be a no-op or lock release
        console.log(`Memory table '${table.tableName}' transaction commit`);
    }

    async xRollback(table: MemoryTable): Promise<void> {
        // For in-memory, we don't have transaction capability
        console.log(`Memory table '${table.tableName}' transaction rollback (no-op)`);
    }

    // Optional rename method
    async xRename(table: MemoryTable, newName: string): Promise<void> {
        const oldTableKey = this.getTableKey(table.schemaName, table.tableName);

        // Update internal registry
        this.tables.delete(oldTableKey);

        // We can't directly modify the tableName due to readonly property
        // In a real implementation, you would update the instance or create a new one
        // For this example we'll just re-add to the registry
        const newTableKey = this.getTableKey(table.schemaName, newName);
        this.tables.set(newTableKey, table);

        console.log(`Memory table renamed from '${table.tableName}' to '${newName}'`);
    }

    // Helper methods
    private getTableKey(schemaName: string, tableName: string): string {
        return `${schemaName.toLowerCase()}.${tableName.toLowerCase()}`;
    }

    private async setupSchema(
        db: Database,
        table: MemoryTable,
        createTableSql: string
    ): Promise<void> {
        // Use the Schema Manager to parse and register the virtual table schema
        // This will ultimately call back to xCreate/xConnect
        await db.schemaManager.declareVtab(
            table.schemaName,
            createTableSql,
            table
        );

        // Extract column info from schema
        // This is a simplification - in a real implementation,
        // we'd parse the schema definition properly
        const tableSchema = db.schemaManager.findTable(table.tableName, table.schemaName);
        if (!tableSchema) {
            throw new SqliteError(`Failed to create schema for memory table ${table.tableName}`, StatusCode.ERROR);
        }

        // Extract column information
        const columns = tableSchema.columns.map(col => ({
            name: col.name,
            type: col.affinity
        }));

        // Find primary key
        let primaryKey: string | null = null;
        if (tableSchema.primaryKeyColumns.length === 1) {
            const pkColIndex = tableSchema.primaryKeyColumns[0];
            primaryKey = tableSchema.columns[pkColIndex]?.name || null;
        }

        // Set up columns in our table
        table.setColumns(columns, primaryKey);
    }
}
