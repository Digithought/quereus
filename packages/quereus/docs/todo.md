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
- ✅ **Predicate Pushdown**: Push filter predicates closer to data sources (Phase 1 complete - basic pushdown working)
- 📋 **Subquery Optimization**: Transform correlated subqueries to joins
- 📋 **Advanced Statistics**: VTab-supplied or ANALYZE-based statistics
- 📋 **Join Algorithms**: Hash joins and merge joins
- 📋 **Aggregate Pushdown**: Push aggregations below joins when semantically valid
- 📋 **Key-driven row-count reduction**: With better key inference, cardinality can be better estimated and efficiencies gained


## 🔄 Current Development Focus

**Core SQL Features**
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

**Query Optimization (Next Priority)**
- [ ] **Phase 1.5 - Access Path Selection**: Complete `SeqScanNode`, `IndexScanNode`, `IndexSeekNode` implementation (currently partial with fallbacks)
- [x] **Predicate Pushdown Phase 1**: Basic filter predicate pushdown to table access nodes
  - [x] Constraint extraction from binary predicates 
  - [x] Filter node elimination for fully-pushed predicates
  - [x] Virtual table integration via BestAccessPlan API
  - [ ] Push down robustly
  - [ ] Enhanced constraint extraction (OR conditions, IN lists, complex expressions)
  - [ ] Join predicate pushdown
  - [ ] Projection pushdown and column trimming
- [ ] **QuickPick Join Optimization**: Implement TSP-inspired join ordering using random greedy tours
  - [ ] Phase 2: Multi-pass optimizer framework
  - [ ] Phase 3: Join cardinality cost model  
  - [ ] Phase 4: Random tour generator with configurable count
  - [ ] Phase 5: Best plan selection and integration
- [ ] **Subquery Optimization**: Transform correlated subqueries to joins where beneficial

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
- [ ] **Distributed Queries**: Query federation across multiple data sources
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

**🔄 Current Focus: OPTIMIZATION & POLISH**  
- The engine handles complex SQL workloads effectively
- Development focus has shifted from core features to optimization and performance
- Foundation is solid for building advanced features and ecosystem integrations

**🎯 Strategic Priority: ACCESS PATH OPTIMIZATION**
- Optimizer Phase 1.5 access path selection is the immediate next milestone
- Will unlock significant performance improvements for data-intensive workloads
- Builds on the robust optimizer framework completed in Phases 0-3

**🎯 Next Strategic Priority: QUICKPICK JOIN OPTIMIZATION**
- Revolutionary TSP-based join ordering will deliver near-optimal plans with minimal complexity
- Requires visited tracking redesign to support multi-pass optimization
- Perfect fit for Quereus' lean architecture and virtual table ecosystem

### Push-down & Federation Roadmap  _(NEW)_

**Phase 2 – Robust Predicate / Projection Push-down**
- [ ] OR-predicate factorisation and split across children
- [ ] `IN (…)`, `BETWEEN`, NULL tests, LIKE/GLOB pattern extraction
- [ ] Predicate push-through `Project`, `Distinct`, `Limit/Offset`, `Sort`
- [ ] Multi-table predicate routing (correlated sub-queries)
- [ ] Residual predicate generator + `handledFilters[]` bitmap to runtime

**Phase 3 – RetrieveNode framework**
- [ ] Introduce `RetrieveNode` (unary, wraps every `TableReference` at build time)
- [ ] `ruleIntroduceRetrieve` (builder)
- [ ] **ruleGrowRetrieve** (single rewrite rule; at each step creates candidate pipeline = parent+current, asks `supports()`, bubbles Retrieve upward if accepted)
- [ ] `ModuleCapabilityAPI.supports()` returns `{supported, cost, ctx}`; cost used versus local plan
- [ ] Update `ruleSelectAccessPath` for RemoteQueryNode vs Scan/Seek

**Phase 4 – Join / Apply rewrite**
- [ ] Replace logical `JoinNode` with **ApplyNode** / filter early in builder; nested-loop semantics preserved
- [ ] Join enumeration operates after Retrieve placement; Apply can later be rewritten into physical hash/merge joins when correlation removed

### VTab / Module Enhancements
- [ ] Add `supports(node, childrenOK)` default mix-in for index-style modules (internal xBestIndex usage)
- [ ] Extend `BestAccessPlanRequest` with `limit`, `requiredOrdering`, `projectedColumns`
- [ ] Provide reference implementation for MemoryTable (supports Filter/Limit/Projection)
- [ ] Documentation + examples for full SQL federation module

### Push-down Testing
- [ ] Add `test/plan/pushdown/*.sql` golden-plan specs asserting:
  - Filter elimination
  - Constraint presence on Retrieve / Scan nodes
  - Pipeline serialisation for RemoteQueryNode
- [ ] Add logic tests that call `query_plan()` and expect zero `Filter` rows
- [ ] CI job runs with `DEBUG=quereus:optimizer:rule*` to ensure rule fires at least once

### Optimiser rule details

**ruleGrowRetrieve (rewrite)**  
Single bottom-up rule that simultaneously:
1. Attempts to graft the current Retrieve’s parent on top of its `pipeline` (proposedPipeline).
2. Calls `module.supports(proposedPipeline)` ⇒ `{ supported, cost, ctx }`.
3. If `supported===true` → Replace parent with a *new* Retrieve containing `proposedPipeline`, cache `ctx`, repeat.
4. If `false` → stop sliding; optimiser continues upward so higher Filters etc. can still be tried later.

This eliminates separate “push-down” versus “slide-up” passes.

### ModuleCapabilityAPI (clarification)
```ts
interface SupportAssessment {
  cost      : number;    // module’s own cost estimate (rows or CPU units)
  ctx?      : unknown;   // opaque data cached in Retrieve for the emitter
}

supports(pipeline: PlanNode, childrenSupported: boolean[]): SupportAssessment | undefined;
```

### Physical conversion
During **impl** phase `ruleSelectAccessPath` uses the cached `assessment`:
- `pipeline == TableReference` ⇒ choose Seq/Index Seek using `assessment.cost`.
- otherwise produce `RemoteQueryNode` with that cost.

### Apply / Join roadmap _(clarification)_
- [ ] Builder: always output `ApplyNode` (outer flag) instead of `JoinNode`.  Inner/Left joins map to Apply+Filter as table shows in optimizer docs.
- [ ] Emitter: nested-loop using correlated right-side call; same performance as before when module declines.
- [ ] Later optimisation may transform non-correlated Apply back into physical hash/merge join.
