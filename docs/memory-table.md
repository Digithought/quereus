# Memory Table Module Documentation

The Memory Table Module provides virtual tables backed by memory for the Quereus engine. These tables support standard SQL operations and can be used for high-performance in-memory data storage that requires SQL query capabilities.


The `MemoryTable` (`src/vtab/memory-table.ts`) provides a general-purpose, B+Tree-backed in-memory table implementation suitable for various internal and user-facing scenarios.

**Key Features:**

*   **B+Tree Backend:** Uses the `digitree` library for efficient, sorted storage.
*   **Flexible Primary Indexing:** Data is primarily indexed by either the implicit `rowid` (default) or by a user-defined single-column or composite `PRIMARY KEY` specified during table creation. The B+Tree automatically maintains the sort order based on this key.
*   **Secondary Index Support:** Allows creation of secondary indexes on one or more columns using `CREATE INDEX`. These are also backed by B+Trees for efficient lookups.
*   **Query Planning:** Implements `xBestIndex` to provide basic query plans:
    *   Considers both primary and secondary indexes.
    *   Full table scans (ascending or descending based on primary key).
    *   Fast equality lookups (`WHERE indexed_col = ?`) on single or composite keys using the most appropriate index.
    *   Range scans (`WHERE indexed_col > ?`, etc.) based on the *first* column of the chosen index.
    *   Satisfies `ORDER BY` clauses that match the chosen index order.
*   **CRUD Operations:** Supports `INSERT`, `UPDATE`, and `DELETE` via the `xUpdate` method, maintaining both primary and secondary indexes.
*   **Transactions & Savepoints:** Supports transactional operations (`BEGIN`, `COMMIT`, `ROLLBACK`) and savepoints using internal buffering for inserts, updates, and deletes.

**Usage Examples:**

*   **Internal Engine Use (Ephemeral Tables):** The VDBE uses `MemoryTable` internally for operations requiring temporary storage, such as materializing subquery results or sorting data. The `Opcode.OpenEphemeral` and `Opcode.Sort` instructions leverage this.
*   **User-Defined In-Memory Tables:** Users can register the `MemoryTableModule` and create persistent (for the `Database` instance lifetime) or temporary in-memory tables using SQL:

    ```typescript
    import { Database, MemoryTableModule } from 'quereus'; // Or adjust path

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

    // Create a secondary index
    await db.exec("CREATE INDEX my_data_name_idx ON my_data (name)");

    // Query using the secondary index
    const resultByName = await db.prepare("SELECT * FROM my_data WHERE name = 'beta'").get();

    // Query using the primary key index
    const results = await db.prepare("SELECT * FROM keyed_data WHERE key_part1 = 'A'").all();
    // Query using rowid
    const row2 = await db.prepare("SELECT value FROM my_data WHERE rowid = 2").get();

    // Drop the secondary index
    await db.exec("DROP INDEX my_data_name_idx");
    ```

**Current Limitations:**

*   **Constraint Enforcement:** Only the `UNIQUE` constraint on the primary BTree key (rowid or PRIMARY KEY) is currently enforced. Other constraints like `NOT NULL`, `CHECK`, `FOREIGN KEY` defined in the `CREATE TABLE` string are parsed but *not* enforced by `MemoryTable` itself during `INSERT` or `UPDATE`.
*   **Default Values:** `DEFAULT` clauses are not applied during `INSERT`.
*   **Advanced Planning:** `xBestIndex` planning is basic. Cost estimation is heuristic. It only considers range scans on the *first* column of an index.
*   **Index Features:** Indices on expressions are not supported. Collation support in indices is basic (inherits from column).
