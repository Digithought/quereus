## Project TODO List & Future Work

This list reflects the current and upcoming work for Quereus. Completed items and status fluff have been removed to keep this focused on actionable tasks.

## 🏗️ Titan Optimizer Implementation Progress

### In Progress
- 🔄 **Phase 1.5 - Access Path Selection**: Seek/range scan infrastructure and optimization rules

### Upcoming Optimizer Work
- 📋 **Subquery Optimization**: Transform correlated subqueries to joins
- 📋 **Advanced Statistics**: VTab-supplied or ANALYZE-based statistics
- 📋 **Join Algorithms**: Hash joins and merge joins
- 📋 **Aggregate Pushdown**: Push aggregations below joins when semantically valid
- 📋 **Key-driven row-count reduction**: With better key inference, cardinality can be better estimated and efficiencies gained
  - 📋 FK→PK join inference: derive keys when ON aligns a PK with an inferred unique set on the other side (e.g., via DISTINCT/GROUP BY)
  - 📋 Optimizer exploitation: prefer join strategies and pruning using `[[]]` and preserved keys


## 🔄 Current Development Focus

**Query Optimization (Current Priority)**
- [ ] **Phase 3 - Advanced Push-down**: Complex optimization with full cost model
  - [ ] Advanced predicate push-down with sophisticated cost decisions (LIKE prefix, complex OR factoring)
  - [ ] Dynamic constraints: plan-time shape, runtime evaluation of binding expressions
  - [ ] Range seeks: pass dynamic lower/upper bounds and extend Memory module scan plan to use them
  - [ ] IN lists: choose between seek-union or residual handling based on index support and list size
  - [ ] Projection and aggregation push-down optimization
  - [ ] Projection Push-down: Eliminate unnecessary column retrieval (leverage stable attribute IDs and key propagation)

**Design Philosophy: Characteristic-Based Rules**
- Rules target logical node characteristics rather than hard-coded node types
- RetrieveNode is the principled exception (represents unique module boundary concept)
- Phase sequencing ensures each optimization stage has proper cost information
- Structural phases (grow-retrieve) precede cost-dependent phases (complex push-down)

**Core SQL Features (Lower Priority)**
- [ ] **DELETE T FROM ...**: Allow specification of target alias for DML ops
- [ ] **Orthogonal relational expressions**: allow any expression that results in a relational expression in a relational expressive context 
- [ ] Values in "select" locations (e.g. views)
- [ ] Expression-based functions
- [ ] Make choice of scheduler run method determined at constructor time, not in run

**Window Functions (Remaining)**
- [ ] **LAG/LEAD**: Offset functions
- [ ] **FIRST_VALUE/LAST_VALUE**: Navigation functions  
- [ ] **RANGE BETWEEN**: Range-based window frames
- [ ] **PERCENT_RANK/CUME_DIST**: Statistical ranking functions

**Type Coercion Enhancements**
- [ ] **ORDER BY**: Enhanced numeric sorting of string columns using coercion

## 🔐 Global Transaction‑Deferred Assertions

Database‑wide integrity assertions deferrable at COMMIT (auto-detected), with efficient row‑level delta checks where provably row‑specific.

- [ ] SQL surface & schema objects
  - [ ] Add `IntegrityConstraint` schema object: name, text/AST/plan of violation query, `dependentTables`, classification per table (row‑specific/global), deferrability, initial mode

- [ ] Dependency discovery & invalidation
  - [ ] During assertion build, resolve base tables referenced by the violation query and store as `dependentTables`. Note that a given table may be referenced multiply by a query; each reference should be regarded independently
  - [ ] Hook into schema change events to invalidate/recompile affected assertions

- [ ] Optimizer analysis: row‑specific vs global (logical, pre‑physical)
  - [ ] Treat `GROUP BY` exactly on a unique key as row‑specific for that table; any aggregation without such grouping is global
  - [ ] Classify presence of windows/set ops (UNION/INTERSECT/EXCEPT/DIFF) as global unless both sides are independently row‑specific

- [ ] Prepared assertion plans (parameterized)
  - [ ] For each assertion and each row‑specific dependent table, compile a parameterized variant of the violation query that binds the table's full unique key at the earliest reference
  - [ ] Maintain binding metadata: table → parameter positions (support composite keys)
  - [ ] For assertions touching multiple tables, prepare one parameterized variant per row‑specific table

- [ ] Commit‑time evaluation engine
  - [ ] Abort commit on first non‑empty result; include constraint name and sample violating keys in error

- [ ] Diagnostics & tooling
  - [ ] `explain_assertion(name)` shows normalized violation query and concise plan (pre‑physical and physical views)
  - [ ] Error formatting: include assertion name and up to N violating key tuples

- [ ] Tests
  - [ ] Parser/DDL round‑trip for assertions
  - [ ] Dependency tracking and invalidation on table/column changes
  - [ ] Row‑specific classification correctness across filters, projections, joins, aggregates, set ops
  - [ ] Commit‑time enforcement for: single‑table FK‑like, multi‑table co‑existence (DIFF), and aggregate‑based global assertions
  - [ ] Savepoint interaction (rollback removes violations)

- [ ] Future enhancements (post‑MVP)
  - [ ] Batched execution: support IN‑list/VALUES parameterization to amortize per‑key runs when many keys change
  - [ ] Optional early (statement‑end) prechecks for single‑table row‑specific assertions to surface errors sooner, still enforcing at COMMIT
  - [ ] Statistics‑aware threshold to choose between per‑key runs vs full scan
  - [ ] Auto‑classify deferrability so users don't need `SET CONSTRAINTS`

## ♻️ Reusable Incremental Delta Runtime (Assertions, Views)

- [ ] Runtime: Delta pipeline kernel
  - [ ] ParameterizedPlanCache keyed by (registrant, relationKey, key-shape)
  - [ ] DeltaExecutor orchestrating global vs per-binding runs with early-exit hook
  - [ ] Savepoint-aware ChangeCapture reuse for COMMIT-time execution
- [ ] Optimizer: Binding-aware analysis
  - [ ] Extend classification with group-specific (GROUP BY / PARTITION BY) keys
  - [ ] Binding propagation across equi-joins to related tables
  - [ ] Residual construction helper to inject `= ?` filters on bound relation
- [ ] Materialized Views (future)
  - [ ] Register view definition and incrementalization strategy
  - [ ] Compute ΔView on COMMIT and merge into storage
  - [ ] `explain_view_delta(name)` diagnostics

### Milestones (Implementation Outline)

1) Change tracking: per‑transaction log keyed by base table, integrate with savepoints.
2) Prepared variants: compile and cache per‑assertion, per‑relationKey parameterized plans with binding metadata.
3) Commit engine: orchestrate global vs per‑key execution; early‑fail on first violation.
4) Diagnostics: `explain_assertion()` and enhanced error messages.


## Declarative Schema - Remaining Work (Future Enhancements)

**Planned:**
- [ ] Rename detection with `old name` hints and stable `id` matching
- [ ] Destructive change gating with `allow_destructive` option
- [ ] `validate_only` and `dry_run` modes for safety
- [ ] Import support: `import schema <alias> from '<url>' cache '<key>' version '<semver>'`
- [ ] Local cache registry for offline imports
- [ ] Idempotent seeds with PK/UNIQUE upsert logic
- [ ] Domain and collation declarations
- [ ] Helper TVFs: `schema_diff()`, `schema_objects()`, `schema_hash()`
- [ ] CLI integration in quoomb
- [ ] View and index DDL generation in diff engine
- [ ] Advanced rename policies (`require-hint` vs `infer-id`)

### Architecture Notes

- **DDL remains primary**: Declarative schema is optional and generates canonical DDL
- **Module-agnostic**: Works with any VTab module, uses standard catalog introspection
- **Safe by default**: Non-destructive operations only (drops require future `allow_destructive` flag)
- **Order-independent**: Forward references allowed within declaration blocks
- **Deterministic**: Schema hash computed from canonical DDL representation
- **Contextual keywords**: `schema`, `version`, `seed` are contextual to avoid breaking `schema()` function or column names

## 📋 Future Development Areas

**Optimizer Enhancements (Near-term)**
- [ ] **Advanced Statistics**: Move beyond naive heuristics to VTab-supplied or ANALYZE-based stats
- [ ] **Sophisticated Cost Models**: Better formulas for complex operations and join algorithms  
- [ ] **Plan Validation**: Runtime tree validation to catch optimizer bugs early
- [ ] **Execution Metrics**: Row-level telemetry for verifying cardinality estimates

**Schema & DDL Enhancements**
- [ ] **Foreign Key Constraints**: REFERENCES constraints with cascading actions
- [ ] **Computed Columns**: Columns with derived values
- [ ] **ALTER TABLE**: More comprehensive ALTER TABLE operations
- [ ] **Materialized Views**: Views with cached results

**Performance & Scalability (Medium-term)**
- [ ] **Memory Pooling**: Reduce allocation overhead in hot paths
- [ ] **Query Caching**: Result caching and invalidation strategies
- [ ] **Streaming Execution**: Better streaming support for large result sets
- [ ] **Parallel Execution**: Multi-threaded query execution for CPU-bound operations

**Developer Experience & Tooling**
- [ ] **Enhanced EXPLAIN**: More detailed query plan analysis capabilities
- [ ] **Performance Profiling**: Detailed execution timing and resource usage
- [ ] **Virtual Table Development Guide**: Best practices for creating custom vtab modules

**Testing & Quality (Ongoing)**
- [ ] **Stress Testing**: Large dataset and concurrent operation testing
- [ ] **Fuzzing**: Automated testing with random SQL generation
- [ ] **Performance Benchmarks**: Regression testing for performance
- [ ] **Cross-platform Testing**: Browser, Node.js, React Native environments

**Advanced Features (Long-term Vision)**
- [ ] **Real-time Queries**: Streaming query execution over live data
- [ ] **Graph Queries**: Graph traversal and pattern matching capabilities
- [ ] **Machine Learning Integration**: Built-in ML functions and operators

**Ecosystem Integration**
- [ ] **Database Connectors**: Interfaces to PostgreSQL, MySQL, SQLite, etc.
- [ ] **ORM Adapters**: Integration with TypeScript/JavaScript ORMs
- [ ] **Cloud Platform**: Cloud-native deployment and scaling options
- [ ] **Data Pipeline Integration**: Standard connectors for ETL workflows

---

## 🔁 Push-down & Federation Roadmap (Active Items)

**Phase 2 – Optimization Pipeline Sequencing**
- [ ] **Join Enumeration Integration**: Ensure join rewriting uses realistic cardinality estimates
  - [ ] Verify join cost model accounts for pushed-down predicates
  - [ ] Test that join enumeration benefits from phase 1-2 optimizations

**Phase 3 – Advanced Push-down Optimization**
- [ ] **Advanced Predicate Push-down** (cost-precise phase): Complex predicate optimization
  - [ ] OR-predicate factorisation and split across children
  - [ ] `IN (…)`, `BETWEEN`, NULL test optimizations
  - [ ] Subquery predicate push-down with correlation analysis
- [ ] **Projection Push-down**: Eliminate unnecessary column retrieval
  - [ ] Project only required attributes through module boundary
  - [ ] Coordinate with SELECT list requirements and JOIN dependencies
- [ ] **Aggregation Push-down**: Push GROUP BY and aggregate functions
  - [ ] Simple aggregates (COUNT, SUM, MIN, MAX) for supported modules
  - [ ] Complex aggregation split strategies
- [ ] **Range Seeks**: Pass dynamic lower/upper bounds and extend Memory module scan/seek plan to use them
- [ ] **IN-list strategy**: Choose between seek-union vs residual based on index coverage and list size

## Misc

- [ ] Improve constraintPlanContainsSubquery() (hard-coded AST traversal may not capture all table references and doesn't honor the spirit of capabilities for dealing robustly with new nodes)
