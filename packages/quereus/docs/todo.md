## Project TODO List & Future Work

This list reflects the **current state** of Quereus - a surprisingly complete SQL query processor with the Titan runtime. Most core SQL features are now implemented and working!

**Core SQL Features**
- [ ] **OLD/NEW on RETURNS**

**Type Coercion**
- [ ] **ORDER BY**: Enhanced numeric sorting of string columns using coercion

**Query Planning**
- [ ] **Cost-Based Optimization**: Better cost estimates for plan selection
- [ ] **Join Reordering**: Optimize join order based on statistics

**JOIN Operations** 
- [ ] **JOIN Optimization**: Join reordering and algorithm selection

**Window Functions**
- [ ] **LAG/LEAD**: Offset functions (Phase 2)
- [ ] **FIRST_VALUE/LAST_VALUE**: Navigation functions (Phase 2)
- [ ] **RANGE BETWEEN**: Range-based window frames (Phase 3)
- [ ] **NTILE**: N-tile distribution functions
- [ ] **PERCENT_RANK/CUME_DIST**: Statistical ranking functions

**Query Optimization Enhancements**
- [ ] **Cost-Based Planning**: Implement sophisticated cost models and statistics
- [ ] **Join Optimization**: Join reordering based on cardinality estimates
- [ ] **Index Selection**: Enhanced `TableSeekNode` for optimal index usage
- [ ] **Predicate Pushdown**: Advanced predicate pushdown optimizations
- [ ] **Constant Folding**: Compile-time evaluation of constant expressions

**Performance & Scalability**
- [ ] **Memory Pooling**: Reduce allocation overhead in hot paths
- [ ] **Query Caching**: Result caching and invalidation strategies
- [ ] **Streaming Execution**: Better streaming support for large result sets
- [ ] **Parallel Execution**: Multi-threaded query execution for CPU-bound operations

**Schema & DDL Enhancements**
- [ ] **Foreign Key Constraints**: REFERENCES constraints with cascading actions
- [ ] **Computed Columns**: Columns with derived values
- [ ] **Schema Versioning**: Track schema changes and invalidate plans
- [ ] **ALTER TABLE**: More comprehensive ALTER TABLE operations
- [ ] **Materialized Views**: Views with cached results

**Error Handling & Diagnostics**
- [ ] **Query Explain**: Enhanced EXPLAIN capabilities for query analysis
- [ ] **Performance Profiling**: Detailed execution timing and resource usage
- [ ] **Plan Visualization**: Tools to visualize and debug query plans

**Testing & Reliability**
- [ ] **Stress Testing**: Large dataset and concurrent operation testing
- [ ] **Fuzzing**: Automated testing with random SQL generation
- [ ] **Performance Benchmarks**: Regression testing for performance
- [ ] **Compatibility Testing**: Cross-platform and environment testing

**Documentation & Tooling**
- [ ] **API Documentation**: Comprehensive API documentation with examples
- [ ] **Query Optimization Guide**: Best practices for query performance
- [ ] **Virtual Table Development**: Guide for creating custom vtab modules
- [ ] **Migration Tools**: Tools for importing data from other databases

**Advanced Features**
- [ ] **Distributed Queries**: Query federation across multiple data sources
- [ ] **Real-time Queries**: Streaming query execution over live data
- [ ] **Graph Queries**: Graph traversal and pattern matching capabilities
- [ ] **Machine Learning Integration**: Built-in ML functions and operators

**Ecosystem Integration**
- [ ] **Module Development**: Interfaces to PostgreSQL, MySQL, SQLite, etc.
- [ ] **ORM Adapters**: Integration with TypeScript/JavaScript ORMs
- [ ] **Cloud Platform**: Cloud-native deployment and scaling options
- [ ] **Data Connectors**: Standard connectors for popular data sources

**Performance & Scale**
- [ ] **Columnar Storage**: Column-oriented storage for analytical workloads
- [ ] **Compression**: Data compression algorithms for memory efficiency
- [ ] **Tiered Storage**: Hot/warm/cold data tiering strategies
- [ ] **Distributed Execution**: Multi-node query execution

---

**Legend:**
- `[ ]`: Not Started
- `[P]`: Partially Implemented / In Progress  
- `[X]`: Completed ✅

**Next Phase Focus:** The primary development focus should shift from implementing missing core SQL features (which are now largely complete) to **optimization, performance, and advanced features**. The engine has a solid foundation and can handle complex SQL workloads effectively.
