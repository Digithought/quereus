import { MisuseError, SqliteError } from '../common/errors';
import { StatusCode } from '../common/constants';
import type { VirtualTableModule } from '../vtab/module';
import { Statement } from './statement';
import type { SqlValue } from '../common/types';
import { SchemaManager } from '../schema/manager';
import type { TableSchema } from '../schema/table';
import type { FunctionSchema } from '../schema/function';
// Placeholder for Function management
// import { FunctionManager } from '../func/manager';

/**
 * Represents a connection to an SQLite database (in-memory in this port).
 * Manages schema, prepared statements, virtual tables, and functions.
 */
export class Database {
    public readonly schemaManager: SchemaManager;
    // private readonly funcManager: FunctionManager;
    private isOpen = true;
    private statements = new Set<Statement>();
    private registeredVTabs: Map<string, { module: VirtualTableModule<any, any>, auxData: unknown }> = new Map();
    // Function registration now delegated to SchemaManager/Schema
    // private registeredFuncs: Map<string, { /* function details */ }> = new Map();
    private isAutocommit = true; // TODO: Manage transaction state

    constructor() {
        this.schemaManager = new SchemaManager(this);
        // this.funcManager = new FunctionManager(this);
        // Initialize default VFS, schema, etc. if needed
        console.log("Database instance created.");
    }

    /**
     * Prepares an SQL statement for execution.
     * @param sql The SQL string to prepare.
     * @returns A Promise resolving to the prepared Statement object.
     * @throws SqliteError on failure (e.g., syntax error).
     */
    async prepare(sql: string): Promise<Statement> {
        if (!this.isOpen) {
            throw new MisuseError("Database is closed");
        }
        console.log(`Preparing SQL: ${sql}`);
        // TODO: Implement actual parsing and VDBE code generation
        // Parser will need access to schemaManager to resolve tables/functions
        // For now, create a placeholder statement
        const stmt = new Statement(this, sql);
        this.statements.add(stmt);
        return stmt;
    }

     /**
     * Executes one or more SQL statements directly.
     * Convenience method, less efficient for repeated execution than prepare/step.
     * @param sql The SQL string(s) to execute.
     * @param callback Optional callback to process result rows.
     * @returns A Promise resolving when execution completes.
     * @throws SqliteError on failure.
     */
    async exec(sql: string, callback?: (row: Record<string, SqlValue>, columnNames: string[]) => void): Promise<void> {
         if (!this.isOpen) {
            throw new MisuseError("Database is closed");
        }
        console.log(`Executing SQL: ${sql}`);
        // TODO: Implement statement splitting and execution loop
        // This is complex as it needs to handle multiple statements and result processing.
        // For a minimal start, we might only support single statements or defer this.
        const stmt = await this.prepare(sql); // Simplified: assumes single statement
        try {
            let result = await stmt.step();
            while (result === StatusCode.ROW) {
                if (callback) {
                    const rowData = stmt.getAsObject(); // Assuming getAsObject method exists
                    const colNames = stmt.getColumnNames(); // Assuming getColumnNames exists
                    callback(rowData, colNames);
                }
                result = await stmt.step();
            }
            if (result !== StatusCode.DONE && result !== StatusCode.OK) { // OK might be valid for non-SELECT exec
                // Prepare might succeed, but step could fail
                throw new SqliteError("Execution failed", result);
            }
        } finally {
            await stmt.finalize();
        }
    }


    /**
     * Registers a virtual table module.
     * @param name The name of the module (used in CREATE VIRTUAL TABLE ... USING name(...)).
     * @param module The module implementation.
     * @param auxData Optional client data passed to xCreate/xConnect.
     * @throws SqliteError if registration fails (e.g., name conflict).
     */
    registerVtabModule(name: string, module: VirtualTableModule<any, any>, auxData?: unknown): void {
        if (!this.isOpen) {
            throw new MisuseError("Database is closed");
        }
        const lowerName = name.toLowerCase();
        if (this.registeredVTabs.has(lowerName)) {
            // Original SQLite allows overwriting, should we? For now, error.
            throw new SqliteError(`Virtual table module '${name}' already registered`, StatusCode.ERROR);
        }
        console.log(`Registering VTab module: ${name}`);
        this.registeredVTabs.set(lowerName, { module, auxData });
        // The module isn't linked to a specific table until CREATE VIRTUAL TABLE
    }

    // Function registration is now handled via SchemaManager / Schema
    // registerFunction(...) // Removed from here

    /**
     * Closes the database connection and releases resources.
     * @returns A promise resolving on completion.
     */
    async close(): Promise<void> {
        if (!this.isOpen) {
            return;
        }
        console.log("Closing database...");
        this.isOpen = false;

        // Finalize all prepared statements
        const finalizePromises = Array.from(this.statements).map(stmt => stmt.finalize());
        await Promise.allSettled(finalizePromises); // Wait even if some fail
        this.statements.clear();

        // Clear schemas, ensuring VTabs are potentially disconnected
        // TODO: Implement proper disconnect/destroy loop based on active VTabs
        this.schemaManager.clearAll(true);

        this.registeredVTabs.clear();
        // Registered functions are cleared within schemaManager.clearAll()
        console.log("Database closed.");
    }

    // --- Internal methods called by Statement ---

    /** @internal Called by Statement when it's finalized */
    _statementFinalized(stmt: Statement): void {
        this.statements.delete(stmt);
    }

    // --- Potentially public helper methods ---

    /** Checks if the database connection is in autocommit mode. */
    getAutocommit(): boolean {
         if (!this.isOpen) {
            throw new MisuseError("Database is closed");
        }
        return this.isAutocommit; // TODO: Implement actual transaction state tracking
    }

    /**
     * Programmatically defines or replaces a virtual table in the 'main' schema.
     * This is an alternative/supplement to using `CREATE VIRTUAL TABLE`.
     * @param definition The schema definition for the table. Must have isVirtual=true and valid module info.
     * @throws SqliteError if the definition is invalid or belongs to another schema.
     */
    defineVirtualTable(definition: TableSchema): void {
        if (!this.isOpen) throw new MisuseError("Database is closed");
        if (!definition.isVirtual || !definition.vtabModule) {
            throw new MisuseError("Definition must be for a virtual table with a module");
        }
        if (definition.schemaName !== 'main') {
             throw new MisuseError("Programmatic definition only supported for 'main' schema currently");
        }
        // TODO: Maybe disconnect/destroy existing vtab instance if replacing?
        this.schemaManager.getMainSchema().addTable(definition);
    }


    // TODO: Add methods for programmatic schema definition if needed
    // defineTable(...) - For regular tables (if ever needed)
    // defineFunction(...) - Wraps schemaManager.getMainSchema().addFunction(...)


    // Internal accessors used by parser/planner/VDBE
    /** @internal */
    _getVtabModule(name: string): { module: VirtualTableModule<any, any>, auxData: unknown } | undefined {
        return this.registeredVTabs.get(name.toLowerCase());
    }

    /** @internal */
     _findTable(tableName: string, dbName?: string | null): TableSchema | undefined {
        return this.schemaManager.findTable(tableName, dbName);
    }

    /** @internal */
    _findFunction(funcName: string, nArg: number): FunctionSchema | undefined {
         return this.schemaManager.findFunction(funcName, nArg);
    }

}