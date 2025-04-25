## Project TODO List & Future Work

This list outlines the remaining major features and refinements needed to make SQLiter a more complete and robust VTab-centric SQL query processor.

**II. VDBE & Compiler Core:**

*   [ ] **Opcode Optimization:**
    *   [ ] Consider opcodes for more efficient type conversions or comparisons if `Affinity` proves insufficient.
    *   [ ] Consider VDBE optimizations (e.g., peephole).
*   [ ] **VDBE Stack Frame Robustness:** Review stack/frame pointer management for edge cases and accuracy.
*   [ ] **Compiler/Parser Syntax Alignment:** Ensure parser, compiler, and documentation consistently reflect the intended SQL syntax (e.g., `CREATE TABLE ... USING`).

**III. Virtual Table Enhancements:**

*   [P] **`MemoryTable` Improvements:**
    *   [ ] Enhance `xBestIndex` to utilize more constraint types (`LIKE`, `GLOB`, `IN`, range scans on non-leading composite key parts). Basic range/EQ planning exists.
    *   [ ] Implement enforcement for `NOT NULL` / `CHECK` constraints defined in the schema string.
    *   [ ] Implement `DEFAULT` value handling during inserts.
    *   [ ] Consider adding optional secondary index support (would require significant changes).
    *   [P] More efficient transactional merge/read: Reads during transactions currently perform a full merge which can be slow. Explore optimization. (`MemoryTable` uses merge logic, performance is TBD).
    *   [ ] **Improve `xFilter` in `memory-table.ts`** - use btree ranges and avoid extra sorting.  Also make the xFilter interface more explicit in general for modules.
    *   [ ] **Refine `mergedResults` approach:**
        *   Current approach in `xFilter` materializes a `mergedResults` array upfront.
        *   **Pros:** Correctly handles transactional consistency (merging pending inserts/updates/deletes) and internal sorting (when `orderByConsumed` is false), significantly simplifying the implementation of `xNext`, `xSeekRelative`, and `xSeekToRowid`.
        *   **Cons:** Can have high memory usage for large tables/unfiltered queries, potentially adds upfront latency to `xFilter` before the first row is fetched.
        *   **Future:** Explore more iterative/generator-based merging within the cursor (`xNext`). This would reduce upfront memory/latency but significantly increase complexity for transactional checks, internal sorting, and especially seeking (`xSeekRelative`/`xSeekToRowid`). May require pushing sorting back to the VDBE in more cases.
*   [ ] **Clean up vtab module interface** - more JS idiomatic.  e.g. move cursor functions into methods on cursor interface.
*   [ ] **VTab Schema Declaration:**
    *   [ ] Standardize how VTab modules declare their columns and constraints to the SchemaManager (beyond `MemoryTable`'s argument parsing). Maybe a dedicated `xDeclareSchema` method?
*   [P] **VTab Transactionality:** Transaction hooks (`xBegin`, `xCommit`, etc.) and savepoint hooks exist in the interface and `MemoryTable`. Need more examples/guidance.
*   [ ] **VTab Shadow Names:**
    *   [ ] Implement `xShadowName` VTab module method check. (Interface method exists, check not implemented).
*   [ ] **Indexable VTabs:** Support `CREATE INDEX` on virtual tables that implement necessary methods (e.g., `xFindFunction` for indexed lookups). (Parser supports, compiler no-op).

**IV. Built-in Functions & Modules:**

*   [P] **Date/Time Functions:** Core functions exist (`date`, `time`, `strftime`...). Need robust parsing (`parseTimeToMillis`) and `strftime` formatting for full SQLite compatibility.
*   [P] **JSON Functions:** Good coverage (`json_extract`, `json_object`, `json_valid`, `json_type`, manipulation functions, aggregates). Review `json_patch` behavior and edge cases.
*   [P] **Reflective Schema:** Virtual sqlite_schema table to expose the schema via a table
*   [ ] **Add More Built-ins:** Consider other useful SQLite functions (e.g., math, more string functions).

**V. Testing & Documentation:**

*   [ ] **Comprehensive Test Suite:**
    *   [ ] Unit tests for parser, compiler opcodes, VDBE execution steps, VTab methods, type handling, built-in functions, transactions, subqueries, CTEs.
    *   [ ] Integration tests covering complex queries, joins, aggregates, subqueries, VTab interactions, transactions, savepoints.
    *   [ ] Use SQL logic tests (porting relevant subsets from SQLite) if feasible.
*   [ ] **Documentation - SQLite variances:**  Detailed description of how this system varies from SQLite
*   [ ] **Documentation - API:** Generate API documentation (e.g., using TypeDoc).
*   [ ] **Documentation - VTabs:** Write a guide on creating custom Virtual Table modules.
*   [P] **Documentation - subsystems:** Give each subsystem it's own architectural overview document (currently `memory-table.md` exists)

**Legend:**
*   `[ ]`: Not Started
*   `[P]`: Partially Implemented / In Progress / Needs Review
*   `[X]`: Completed / Mostly Complete
