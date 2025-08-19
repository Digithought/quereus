## Project TODO List & Future Work

This list reflects the **current state** of Quereus - a feature-complete SQL query processor with a modern Titan optimizer architecture. The core infrastructure is solid and most foundational work is complete!

## 🏗️ Titan Optimizer Implementation Progress

### Completed Phases
- ✅ **Phase 0 - Groundwork**: Cost models, constraint analysis, shared caching utilities, development standards
- ✅ **xBestIndex Refactor**: Modern type-safe BestAccessPlan API replacing legacy SQLite-style interfaces  
- ✅ **Phase 1 - Core Framework**: Rule registration, trace framework, physical properties, statistics abstraction, emitter metadata, golden plan tests
- ✅ **Phase 2 - Cache & Visualize**: Intelligent materialization advisory, async stream utilities, PlanViz CLI tool
- ✅ **Phase 2.5 - Generic Tree Rewriting**: Abstract `withChildren()` method for robust tree transformations with attribute ID preservation
- ✅ **Phase 3 - Constant Folding**: Functional safety flags, runtime-based evaluation, expression boundary optimization

### In Progress
- 🔄 **Phase 1.5 - Access Path Selection**: Seek/range scan infrastructure and optimization rules

### Upcoming Optimizer Work
- ✅ **Predicate Pushdown**: Push filter predicates closer to data sources (basic pushdown working; extend normalization and extraction: OR→IN, BETWEEN, IN lists)
- 📋 **Subquery Optimization**: Transform correlated subqueries to joins
- 📋 **Advanced Statistics**: VTab-supplied or ANALYZE-based statistics
- 📋 **Join Algorithms**: Hash joins and merge joins
- 📋 **Aggregate Pushdown**: Push aggregations below joins when semantically valid
- 📋 **Key-driven row-count reduction**: With better key inference, cardinality can be better estimated and efficiencies gained
  - ✅ Declare unique keys when produced:
    - ✅ DISTINCT → all-columns unique key (physical properties)
    - ✅ GROUP BY → unique key over grouping columns; global aggregate → `[[]]` (≤1 row)
  - ✅ Equality IndexSeek on full PK → `estimatedRows=1`, `uniqueKeys=[[]]`
  - ✅ Propagate `uniqueKeys` and `ordering` through Filter/Sort/Limit; Project maps keys via attribute-ID column references
  - ✅ Equi-join key preservation (INNER/CROSS): if join columns cover a unique key on one side, preserve the other side’s keys and cap `estimatedRows`
  - 📋 FK→PK join inference: derive keys when ON aligns a PK with an inferred unique set on the other side (e.g., via DISTINCT/GROUP BY)
  - 📋 Optimizer exploitation: prefer join strategies and pruning using `[[]]` and preserved keys


## 🔄 Current Development Focus

**Query Optimization (Current Priority)**
- [x] **Phase 1 - Retrieve-node Infrastructure**: Complete foundation for query push-down ✅
  - [x] RetrieveNode wraps all table access 
  - [x] VirtualTableModule.supports() API for query-based modules
  - [x] VirtualTable.xExecutePlan() runtime execution
  - [x] RemoteQueryNode for physical query push-down
  - [x] Access path rule integration and test infrastructure
- [x] **Phase 2 - Optimization Pipeline Sequencing**: Implement characteristic-based optimization phases
  - [x] ruleGrowRetrieve: Structural sliding to maximize module query segments
  - [x] Early predicate push-down: Cost-light optimization (across Sort/Distinct/eligible Project; into Retrieve)
  - [x] Join enumeration integration: Ensure cost model benefits from push-down
    - [x] Greedy commute for INNER joins: place smaller (or singleton) input on the left
    - [x] QuickPick tours (left-deep): random-start greedy with cross-product penalty
    - [x] QuickPick tours (bushy): greedy component merging
    - [x] Enabled by default with tuning limits; only replaces on meaningful improvement
  - [x] Retrieve as call-boundary: track `bindings` (params/correlated) for enveloped pipeline; pass to physical access
  - [x] Supported-only placement: push only module/index-supported predicate fragments under `Retrieve`; keep residuals above
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
- [ ] Make "on conflict" an argument of xUpdate, rather than _onConflict row voodoo:
```ts
				(newRow as any)._onConflict = plan.onConflict || 'abort';
				await vtab.xUpdate!('insert', newRow);
```
- [ ] Fix suppressed constant folding issue (see Known Issues in optimizer.md)
- [ ] Complete constraint extraction implementation (currently has placeholder logic)
- [ ] More intelligent key inference for joins and beyond
- [ ] Make choice of scheduler run method determined at constructor time, not in run

**Window Functions (Remaining)**
- [ ] **LAG/LEAD**: Offset functions
- [ ] **FIRST_VALUE/LAST_VALUE**: Navigation functions  
- [ ] **RANGE BETWEEN**: Range-based window frames
- [ ] **PERCENT_RANK/CUME_DIST**: Statistical ranking functions

**Type Coercion Enhancements**
- [ ] **ORDER BY**: Enhanced numeric sorting of string columns using coercion

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

## 📊 Project Status Summary

**✅ Core Foundation: COMPLETE**
- SQL parser, planner, runtime, and optimizer architecture
- Complex query support (joins, subqueries, CTEs, window functions)
- Comprehensive constraint system and transaction support
- Modern optimizer with constant folding and intelligent caching
- **NEW**: Complete push-down infrastructure with RetrieveNode architecture

**🔄 Current Focus: ADVANCED OPTIMIZATION**  
- Phase 1 Retrieve-node infrastructure: ✅ **COMPLETED**
- The engine handles complex SQL workloads effectively
- Development focus: ruleGrowRetrieve implementation for dynamic push-down optimization
- Foundation is solid for building advanced federation and optimization features

**🎯 Strategic Priority: RULEGRORETRIEVE IMPLEMENTATION**
- Phase 2 ruleGrowRetrieve is the immediate next milestone  
- Will enable dynamic sliding of operations into virtual table modules
- Cost-based decision making between local and remote execution
- Builds on the robust RetrieveNode infrastructure completed in Phase 1

**🎯 Next Strategic Priority: QUICKPICK JOIN OPTIMIZATION**
- Revolutionary TSP-based join ordering will deliver near-optimal plans with minimal complexity
- Requires visited tracking redesign to support multi-pass optimization
- Perfect fit for Quereus' lean architecture and virtual table ecosystem

### Push-down & Federation Roadmap

**Phase 1 – Retrieve-node Infrastructure** ✅ **COMPLETED**
- ✅ Introduce `RetrieveNode` (unary, wraps every `TableReference` at build time)
- ✅ `ModuleCapabilityAPI.supports()` returns `{cost, ctx}`; cost used versus local plan
- ✅ Update `ruleSelectAccessPath` for RemoteQueryNode vs Scan/Seek
- ✅ `VirtualTable.xExecutePlan()` method for query-based push-down execution
- ✅ Test module infrastructure for validating query-based push-down

**Phase 2 – Optimization Pipeline Sequencing**
- [x] **ruleGrowRetrieve** (structural pass, top-down): Slide operations into `RetrieveNode` to maximize module-supported query segments
  - [x] Walk plan top-down; for each parent above a `RetrieveNode`, create candidate pipeline and test `supports(candidatePipeline)`
  - [x] Slide `RetrieveNode` upward when the module supports the expanded pipeline (including complex nodes like joins when applicable)
  - [x] If no `supports()`, use index-style fallback (`getBestAccessPlan`) for Filter/Sort/Limit when it yields clear benefit (handled filters, ordering, or enforced limit)
  - [x] Stop when module declines; result is fixed maximum module-backed query segments
- [x] **Predicate Push-down via supports()** (cost-light phase): Validate pushdown through module acceptance
  - [x] Use `supports()` for query-based modules to both validate and price push-down
  - [x] For index-style modules, rely on `getBestAccessPlan()` translation of constraints, ordering, and limit - use a system-supplied `supports()`
  - [x] Purpose: Improve cardinality estimates and reduce upstream work using module-backed cost reductions
  - [x] Policy: push only supported fragments into `Retrieve`; residuals remain above (never pushed down)

Notes:
- Retrieve logical attributes now expose `bindingsCount` and `bindingsNodeTypes` (visible via `query_plan().properties`) to aid debugging and verification of binding capture.
- Basic predicate push-down into Retrieve uses supported-only fragments; residual predicates remain above Retrieve. Index-style fallback similarly injects only supported filter fragments inside the pipeline.
- `SetOperation` is excluded from grow-retrieve to avoid structural oscillation; predicate push-down still applies to branch pipelines.
- Physicalization invariant: all `Retrieve` nodes must be rewritten to concrete access nodes or `RemoteQuery` in the physical pass (enforced by validation).
- Robust PK equality seeks: full-PK equality is recognized by column index and selects `IndexSeek` even if provider `handledFilters` ordering differs.
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

### VTab / Module Enhancements
- [ ] Add `
