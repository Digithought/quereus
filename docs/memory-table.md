# Memory Table Module Documentation

The Memory Table Module provides virtual tables backed by memory for the SQLiter engine. These tables support standard SQL operations and can be used for high-performance in-memory data storage that requires SQL query capabilities.


The `MemoryTable` (`src/vtab/memory-table.ts`) provides a general-purpose, B+Tree-backed in-memory table implementation suitable for various internal and user-facing scenarios.

**Key Features:**

*   **B+Tree Backend:** Uses the `digitree` library for efficient, sorted storage.
*   **Flexible Indexing:** Data is primarily indexed by either the implicit SQLite `rowid` (default) or by a user-defined single-column or composite `PRIMARY KEY` specified during table creation. The B+Tree automatically maintains the sort order based on this key.
*   **Query Planning:** Implements `xBestIndex` to provide basic query plans:
    *   Full table scans (ascending or descending based on BTree key).
    *   Fast point lookups (`WHERE key = ?`).
    *   Range scans (`WHERE key > ?`, `WHERE key <= ?`, `WHERE key BETWEEN ? AND ?`) based on the *first* component of the BTree key.
    *   Satisfies `ORDER BY` clauses that match the BTree key order (ascending or descending).
*   **CRUD Operations:** Supports `INSERT`, `UPDATE`, and `DELETE` via the `xUpdate` method.

**Usage Examples:**

*   **Internal Engine Use (Ephemeral Tables):** The VDBE can use `MemoryTable` internally for operations requiring temporary storage, such as materializing subquery results or sorting data (though sorting opcodes are not yet fully implemented). The `Opcode.OpenEphemeral` instruction leverages this, creating a `MemoryTable` keyed by `rowid`.
*   **User-Defined In-Memory Tables:** Users can register the `MemoryTableModule` and create persistent (for the `Database` instance lifetime) or temporary in-memory tables using SQL:

    ```typescript
    import { Database, MemoryTableModule } from 'sqliter'; // Or adjust path

    const db = new Database();
    // Register the module (can be done once)
    db.registerVtabModule('memory', new MemoryTableModule());

    // Create a table keyed by rowid (default)
    await db.exec(`
        CREATE VIRTUAL TABLE main.my_data USING memory(
            -- Pass the schema definition as an argument
            "CREATE TABLE x(
                id INTEGER, -- Just a regular column
                name TEXT,
                value REAL
            )"
        );
    `);

    // Create a table keyed by a specific PRIMARY KEY
    await db.exec(`
        CREATE VIRTUAL TABLE temp.keyed_data USING memory(
            "CREATE TABLE y(
                key_part1 TEXT,
                key_part2 INTEGER,
                data BLOB,
                PRIMARY KEY (key_part1, key_part2) -- Composite key
            )"
        );
    `);

    // Insert data
    await db.exec("INSERT INTO my_data (id, name, value) VALUES (1, 'alpha', 1.23), (2, 'beta', 4.56)");
    await db.exec("INSERT INTO keyed_data VALUES ('A', 10, x'0102'), ('B', 5, x'0304')");

    // Query using the index
    const results = await db.prepare("SELECT * FROM keyed_data WHERE key_part1 = 'A'").all();
    // Query using rowid
    const row2 = await db.prepare("SELECT value FROM my_data WHERE rowid = 2").get();
    ```

**Current Limitations:**

*   **Constraint Enforcement:** Only the `UNIQUE` constraint on the effective BTree key (rowid or PRIMARY KEY) is currently enforced. Other constraints like `NOT NULL`, `CHECK`, `FOREIGN KEY` defined in the `CREATE TABLE` string are parsed but *not* enforced by `MemoryTable` itself during `INSERT` or `UPDATE`.
*   **Default Values:** `DEFAULT` clauses are not applied during `INSERT`.
*   **Advanced Planning:** `xBestIndex` planning is basic. It doesn't utilize indexes for `LIKE`, `GLOB`, or range scans on non-leading components of composite keys. Cost estimation is heuristic.
*   **Transactionality:** `xBegin`, `xCommit`, `xRollback` are no-ops. Data modifications are directly applied to the BTree. Atomicity relies on the higher-level database transaction mechanism (if used) and `Latches` for operation serialization.
