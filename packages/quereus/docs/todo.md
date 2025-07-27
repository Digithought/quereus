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

**Query Optimization (Current Priority)**
- [x] **Phase 1 - Retrieve-node Infrastructure**: Complete foundation for query push-down ✅
  - [x] RetrieveNode wraps all table access 
  - [x] VirtualTableModule.supports() API for query-based modules
  - [x] VirtualTable.xExecutePlan() runtime execution
  - [x] RemoteQueryNode for physical query push-down
  - [x] Access path rule integration and test infrastructure
- [ ] **Phase 2 - Optimization Pipeline Sequencing**: Implement characteristic-based optimization phases
  - [ ] ruleGrowRetrieve: Structural sliding to maximize module query segments
  - [ ] Early predicate push-down: Cost-light optimization for better cardinality estimates  
  - [ ] Join enumeration integration: Ensure cost model benefits from push-down
- [ ] **Phase 3 - Advanced Push-down**: Complex optimization with full cost model
  - [ ] Advanced predicate push-down with sophisticated cost decisions
  - [ ] Projection and aggregation push-down optimization

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
- [ ] **ruleGrowRetrieve** (structural phase): Bottom-up sliding to maximize module-supported query segments
  - [ ] Walk plan bottom-up, test `supports(candidatePipeline)` for each RetrieveNode
  - [ ] Slide RetrieveNode upward when module supports expanded pipeline
  - [ ] Stop sliding when `supports()` returns undefined (capability boundary reached)
  - [ ] Result: Fixed, maximum "query segments" for all base relations
- [ ] **Early Predicate Push-down** (cost-light phase): Push obviously beneficial predicates
  - [ ] Target simple filter characteristics (constants, key equality, LIMIT 1)
  - [ ] Purpose: Improve cardinality estimates before join enumeration
  - [ ] Only push predicates that modules explicitly support
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

### VTab / Module Enhancements
- [ ] Add `
