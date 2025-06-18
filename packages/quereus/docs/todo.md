## Project TODO List & Future Work

This list reflects the **current state** of Quereus - a feature-complete SQL query processor with a modern Titan optimizer architecture. The core infrastructure is solid and most foundational work is complete!

## 🔄 Current Development Focus

**Core SQL Features**
- [ ] **DELETE T FROM ...**: Allow specification of target alias for DML ops
- [ ] **Orthogonal relational expressions**: allow any expression that results in a relational expression in a relational expressive context 
- [ ] Default nullability to `not null` and document
- [ ] Values in "select" locations (e.g. views)
- [ ] Expression-based functions

**Query Optimization (Next Priority)**
- [ ] **Phase 1.5 - Access Path Selection**: `SeqScanNode`, `IndexScanNode`, `IndexSeekNode` physical access infrastructure
- [ ] **Predicate Pushdown**: Advanced filter predicate optimization closer to data sources
- [ ] **Join Reordering**: Cost-based join order optimization using cardinality estimates
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
- [ ] **ESLint Rules**: Prevent physical nodes in builder code, enforce conventions
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
