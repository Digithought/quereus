## Project TODO List & Future Work

This list outlines the remaining major features and refinements needed to make SQLiter a more complete and robust VTab-centric SQL query processor.

**I. Parser & Compiler:**

*   [P] **FROM Clause Subqueries (Derived Tables):** Basic structure exists (AST, schema registration). Requires:
    *   [ ] Implement VDBE execution logic (e.g., materialization into ephemeral table).
    *   [ ] Handle correlation with outer query values correctly (re-materialization or deferred execution).
    *   [ ] Refactor nested loop generation logic for reuse within subquery materialization if subquery contains joins.
*   [ ] **FROM Clause Table-Valued Functions:** Basic structure exists (AST, schema registration placeholder).
    *   [ ] Implement schema lookup mechanism (via registry or module interface).
    *   [ ] Define VDBE/VTab mechanism for passing arguments via VFilter.
    *   [ ] Implement VDBE execution logic for calling functions.

*   [ ] **Query Planning:**
    *   [ ] Add syntax to table schema to specify estimated rows
    *   [ ] Estimate rows for subqueries

Review items:

*   [ ] In SchemaManager.declareVtab(), there's a placeholder schema pattern where virtual table modules should override the placeholder columns. This could be clearer with a base interface or method.
*   [ ] In importSchemaJson(), the constraint expressions are deserialized as placeholder null literals. This is a known limitation but could pose problems if the schema is being used with actual constraints.
*   [ ] Some of the type casting with satisfies in _findTable() is a good pattern but might be unnecessary in some places.
*   [ ] The error handling for vtab destruction in dropTable() is asynchronous but doesn't fully handle the failure case. This could be improved, potentially by returning the promise to the caller.
*   [ ] In affinity.ts, there was a TODO comment about more robust SQLite-like parsing for edge cases in the tryParseReal function. This might need future attention to fully match SQLite's behavior.
*   [ ] In comparison.ts, the collation system relies on a global map of collation functions. This works, but you might want to consider making it instance-based in the future for better isolation.
*   [ ] The VdbeRuntime in runtime.ts has fairly complex stack management logic. It might be worth considering additional bounds checking to prevent potential issues.
*   [ ] The error handling in several of the instruction handlers seems robust, but error propagation between async calls should be carefully tested, especially in the VTab-related code.
*   [ ] The P4 operand types in instruction.ts have several placeholder types that might need to be fully implemented as the codebase evolves.
*   [ ] Anywhere we catch our own exceptions, we should instead have a way to check without throw/catch (not an exceptional exception)

**II. VDBE & Compiler Core:**

*   [ ] **Opcode Optimization:**
    *   [ ] Consider VDBE optimizations (e.g., peephole).
    *   [ ] Cache common allocations (e.g., small buffers for `ZeroBlob`).
*   [ ] **VDBE Stack Frame Robustness:** Review stack/frame pointer management for edge cases and accuracy.
*   [ ] **Runtime Checks:** Add explicit runtime checks for existence of required methods before calling (e.g., `xStep`/`xFinal` in `AggStep`/`AggFinal`).
*   [ ] **Compiler/Parser Syntax Alignment:** Ensure parser, compiler, and documentation consistently reflect the intended SQL syntax (e.g., `CREATE TABLE ... USING`).

**III. Virtual Table Enhancements:**

*   [P] **`MemoryTable` Improvements:**
    *   [ ] Enhance `xBestIndex` to utilize more constraint types (`LIKE`, `GLOB`, `IN`, range scans on non-leading composite key parts). Basic range/EQ planning exists.
    *   [P] More efficient transactional merge/read: Layer cursors merge modifications, but performance under heavy load or deep layer chains could be optimized.
    *   [ ] Improve `xBestIndex` and layer cursor scan planning to better utilize B-Tree ranges.
*   [ ] **Clean up vtab module interface** - more JS idiomatic.  e.g. move cursor functions into methods on cursor interface.
*   [P] **VTab Transactionality:** Transaction hooks (`xBegin`, `xCommit`, etc.) and savepoint hooks exist in the interface and `MemoryTable`. Need more examples/guidance.
*   [ ] **VTab Shadow Names:**
    *   [ ] Implement `xShadowName` VTab module method check. (Interface method exists, check not implemented).
*   [ ] **Indexable VTabs:** Support `CREATE INDEX` on virtual tables that implement necessary methods (e.g., `xFindFunction` for indexed lookups). (Parser supports, compiler no-op).

**V. Testing & Documentation:**

*   [ ] **Comprehensive Test Suite:**
    *   [ ] Performance/regression tests (benchmarks).
    *   [ ] CI configuration for automated testing (quick, full, browser).
    *   [ ] Use SQL logic tests (porting relevant subsets from SQLite) if feasible.
*   [ ] **Documentation - SQLite variances:** Detailed description of how this system varies from SQLite
*   [ ] **Documentation - API:** Generate API documentation (e.g., using TypeDoc).
*   [ ] **Documentation - VTabs:** Write a guide on creating custom Virtual Table modules.
*   [P] **Documentation - subsystems:** Give each subsystem it's own architectural overview document

**Legend:**
*   `[ ]`: Not Started
*   `[P]`: Partially Implemented / In Progress / Needs Review
*   `[X]`: Completed / Mostly Complete
