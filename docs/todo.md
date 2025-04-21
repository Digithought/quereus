## Project TODO List & Future Work

This list outlines the remaining major features and refinements needed to make SQLiter a more complete and robust VTab-centric SQL query processor.

**I. Core Query Processing Features:**

*   [P] **Join Implementation:**
    *   [ ] Potentially optimize join algorithms (e.g., hash join if beneficial for specific VTabs).
*   [P] **Subquery Enhancements:**
    *   [P] Implement support for correlated subqueries (Core helpers exist, thorough review and needs state management refinement).
*   [P] **Built-in Functions:**
    *   [ ] Implement standard Date/Time functions (`date`, `time`, `datetime`, `julianday`, `strftime`).
    *   [ ] Consider adding JSON functions (`json_extract`, etc.).
*   [ ] Sort Opcode: The implementation notes that the Sort opcode needs review for stack frame compatibility (src/vdbe/engine.ts). While sorting typically uses ephemeral tables/cursors, careful verification is needed.
*   [ ] LEFT JOIN NULL Padding (compileSelectStatement): The current implementation re-runs compileSelectCore during the loop closing phase just to get the columnMap for NULL padding. This is inefficient and could potentially lead to incorrect register allocation if not careful. It would be better to run compileSelectCore once before the main loop, store its columnMap, and use that map for both the main row processing and the NULL padding logic. This would require restructuring compileSelectStatement.
*   [ ] Aggregate xStep Error Handling: Errors within the xStep function of aggregates (src/func/registration.ts, src/vdbe/engine.ts) are currently caught and logged but don't seem to halt the query or propagate an error state properly, unlike errors in xFunc or xFinal. SQLite's C API allows xStep to signal errors.
*   [ ] Nested Correlated Subqueries: As noted in src/compiler/statement.ts (compileSelectCoreStatement), compileExpression might need refinement to correctly pass down correlation information (correlation and argumentMap) when compiling deeply nested subquery expressions.

**II. VDBE & Compiler Core:**

*   [X] **Opcode Implementation:**
    *   [ ] Consider opcodes for more efficient type conversions or comparisons if `Affinity` proves insufficient.
    *   [ ] Consider VDBE optimizations (e.g., peephole).
*   [P] **Type System & Affinity:**
    *   [P] Ensure rigorous and consistent type handling in `compareSqlValues` and arithmetic operations, matching SQLite affinity rules precisely (especially NUMERIC).
    *   [ ] Implement full Collation support for comparisons and ordering (e.g., NOCASE, RTRIM).
*   [ ] **Error Reporting:**
    *   [ ] Improve detail, context, and consistency of error messages and codes throughout the engine.

**III. Virtual Table Enhancements:**

*   [ ] **`MemoryTable` Improvements:**
    *   [ ] Enhance `xBestIndex` to utilize more constraint types (`LIKE`, `GLOB`, `IN`, range scans on non-leading composite key parts).
    *   [ ] Implement enforcement for `NOT NULL` / `CHECK` constraints defined in the schema string.
    *   [ ] Implement `DEFAULT` value handling during inserts.
    *   [ ] Consider adding optional secondary index support (would require significant changes).
    *   [P] More efficient transactional merge/read: Reads during transactions currently perform a full merge which can be slow. Explore optimization.
*   [ ] **VTab Schema Declaration:**
    *   [ ] Standardize how VTab modules declare their columns and constraints to the SchemaManager (beyond `MemoryTable`'s argument parsing). Maybe a dedicated `xDeclareSchema` method?
*   [ ] **VTab Transactionality:**
    *   [ ] Provide more examples or guidance on implementing transactional VTabs using `xBegin`, `xCommit`, `xSavepoint` hooks.
*   [ ] **More VTab Examples:**
    *   [ ] Implement other useful VTabs (e.g., CSV reader, object array adapter, generator function adapter).
*   [ ] **VTab Shadow Names:**
    *   [ ] Implement `xShadowName` VTab module method check.

**IV. SQL Feature Support (Lower Priority):**

*   [ ] **Window Functions:** Requires significant VDBE and compiler changes (partitioning, frame management).
*   [ ] **Common Table Expressions (CTEs):** Recursive and non-recursive.
*   [ ] **Triggers:** Would require sub-program compilation and execution logic.
*   [ ] **Views:** Implement `CREATE VIEW` execution (requires storing view definition and substituting during compilation).
*   [ ] **Indexes:** Implement `CREATE/DROP INDEX` execution (relevant mainly if non-VTab storage were added, or for VTabs that support external indexing).
*   [P] **ALTER TABLE:** Implement execution for ADD/DROP/RENAME COLUMN, potentially interacting with VTabs via `xRename`. (Parser supports, compiler is no-op).

**V. Testing & Documentation:**

*   [ ] **Comprehensive Test Suite:**
    *   [ ] Unit tests for parser, compiler opcodes, VDBE execution steps, VTab methods, type handling, built-in functions.
    *   [ ] Integration tests covering complex queries, joins, aggregates, subqueries, VTab interactions, transactions, savepoints.
    *   [ ] Use SQL logic tests (porting relevant subsets from SQLite) if feasible.
*   [ ] **Documentation:**
    *   [ ] Expand `README.md` with clear setup/usage examples and API details.
    *   [ ] Generate API documentation (e.g., using TypeDoc).
    *   [ ] Write a guide on creating custom Virtual Table modules.
    *   [ ] Document VDBE opcodes and their behavior.
