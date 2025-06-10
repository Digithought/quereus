## Project TODO List & Future Work

This list reflects the **current state** of Quereus - a surprisingly complete SQL query processor with the Titan runtime. Most core SQL features are now implemented and working!

## I. Type System & Coercion ✅ (Nearly Complete)

**Type Coercion**
- [X] **Binary Operations**: All comparison and arithmetic operators ✅
- [X] **Aggregate Functions**: Context-aware coercion (SUM vs COUNT vs JSON) ✅
- [X] **Unary Operations**: NOT, IS NULL, unary +/-, bitwise operators ✅  
- [X] **CAST Operations**: Full explicit type conversion ✅
- [X] **Built-in Scalar Functions**: Most scalar functions with proper type handling ✅
- [ ] **ORDER BY**: Enhanced numeric sorting of string columns using coercion

**Type Affinity & Storage**
- [X] **Column Type Affinity**: Basic type affinity working in storage ✅
- [X] **Column Constraints**: NOT NULL, CHECK constraints with proper type coercion ✅

## II. Core SQL Features ✅ (Complete!)

**SELECT Operations**
- [X] **Basic SELECT**: Project, Filter, Sort, Distinct, Limit/Offset ✅
- [X] **Aggregate Queries**: GROUP BY, HAVING, all aggregate functions ✅
- [X] **Window Functions**: Comprehensive implementation with ranking, aggregate functions, and frame specifications ✅
- [X] **Set Operations**: UNION, INTERSECT, EXCEPT (all variants) ✅

**FROM Clause**
- [X] **Table References**: Full table and alias support ✅
- [X] **Subqueries**: Scalar subqueries, correlated subqueries ✅
- [X] **CTEs**: Both regular and recursive WITH support ✅
- [X] **Table-Valued Functions**: Complete TVF framework ✅
- [X] **JOINs**: INNER, LEFT, RIGHT, CROSS JOIN support ✅

**DML Operations** 
- [X] **INSERT**: Multi-row, INSERT...SELECT, with RETURNING ✅
- [X] **UPDATE**: Full UPDATE with assignments, with RETURNING ✅
- [X] **DELETE**: Full DELETE with predicates, with RETURNING ✅

**DDL Operations**
- [X] **CREATE/DROP TABLE**: Full table management ✅
- [X] **CREATE/DROP VIEW**: Full view support ✅
- [X] **CREATE INDEX**: Index creation with UNIQUE, multi-column, DESC support ✅
- [X] **ALTER TABLE ADD CONSTRAINT**: Dynamic constraint addition ✅

**Advanced SQL**
- [X] **CASE Expressions**: Both simple and searched CASE ✅
- [X] **Scalar Functions**: Complete function call framework ✅
- [X] **Parameter References**: Named and positional parameters ✅
- [X] **Transaction Control**: BEGIN, COMMIT, ROLLBACK, SAVEPOINT ✅
- [X] **DISTINCT**: Full SELECT DISTINCT support ✅
- [X] **Constraints**: NOT NULL, CHECK constraints with operation-specific triggers ✅

## III. Runtime Architecture ✅ (Titan is Working!)

**Query Execution**
- [X] **Instruction Scheduling**: Async instruction execution ✅
- [X] **Context Management**: Row descriptors and attribute resolution ✅
- [X] **Stream Processing**: Efficient async iterator patterns ✅
- [X] **Memory Management**: Proper context cleanup and resource management ✅

**Query Planning**
- [X] **Physical Plans**: Complete planner → emitter → runtime pipeline ✅
- [X] **Correlation Handling**: Correlated subqueries working correctly ✅
- [X] **JOIN Planning**: Full join planning and execution ✅
- [X] **Scalar Operations**: UnaryOpNode, BinaryOpNode, CastNode, CollateNode, CaseExprNode all implemented ✅
- [ ] **Cost-Based Optimization**: Better cost estimates for plan selection
- [ ] **Join Reordering**: Optimize join order based on statistics

## IV. Virtual Table Framework ✅ (Robust!)

**Core VTab Support**
- [X] **xConnect/xQuery**: Full table scan and query support ✅
- [X] **xUpdate**: INSERT/UPDATE/DELETE operations ✅ 
- [X] **Transaction Integration**: VTab transaction coordination ✅
- [X] **Connection Management**: Proper connection lifecycle ✅

**MemoryTable Improvements**
- [P] **Index Optimization**: Better xBestIndex for LIKE, GLOB, IN, ranges
- [P] **Transaction Performance**: Optimize layer cursor merge operations

## V. Recently Implemented Features ✅

**JOIN Operations** ✅ (Complete!)
- [X] **INNER/LEFT/RIGHT/CROSS JOIN**: All basic join types working ✅
- [X] **JOIN Planning**: Full planning for JOIN types with JoinNode ✅
- [X] **JOIN Emitters**: Complete emitJoin with proper attribute handling ✅
- [X] **Join Condition Planning**: Proper condition handling and scope management ✅
- [X] **Multiple JOINs**: Chain multiple joins correctly ✅
- [ ] **JOIN Optimization**: Join reordering and algorithm selection

**Window Functions** ✅ (Comprehensive!)
- [X] **Ranking Functions**: ROW_NUMBER, RANK, DENSE_RANK, NTILE ✅
- [X] **Windowed Aggregates**: COUNT, SUM, AVG, MIN, MAX with OVER clauses ✅
- [X] **PARTITION BY**: Full partitioning support ✅
- [X] **Window Frames**: ROWS BETWEEN, UNBOUNDED PRECEDING/FOLLOWING ✅
- [X] **NULLS FIRST/LAST**: Null ordering in window specifications ✅
- [X] **Registration System**: Extensible window function registration ✅
- [X] **Performance Optimization**: Groups functions by window specifications ✅
- [ ] **LAG/LEAD**: Offset functions (Phase 2)
- [ ] **FIRST_VALUE/LAST_VALUE**: Navigation functions (Phase 2)
- [ ] **RANGE BETWEEN**: Range-based window frames (Phase 3)

**Advanced Subquery Support** ✅ (Complete!)
- [X] **Correlated Subqueries**: Full support for complex correlated patterns ✅
- [X] **EXISTS/NOT EXISTS**: Complete implementation ✅
- [X] **Scalar Subqueries**: Full scalar subquery support in expressions ✅
- [X] **IN Subqueries**: Both correlated and uncorrelated IN support ✅

**Advanced SQL Features** ✅ (Complete!)
- [X] **DISTINCT**: Full support for SELECT DISTINCT ✅
- [X] **Set Operations**: UNION, INTERSECT, EXCEPT with proper attribute handling ✅
- [X] **Recursive CTEs**: Robust WITH RECURSIVE implementation ✅
- [X] **Views**: CREATE/DROP VIEW with full query support ✅
- [X] **Constraints**: Comprehensive constraint system with operation-specific triggers ✅

## VI. Current Development Priorities

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

**Advanced Window Functions**
- [ ] **LAG/LEAD**: Offset functions for accessing previous/next rows
- [ ] **FIRST_VALUE/LAST_VALUE**: Navigation functions within window frames
- [ ] **RANGE BETWEEN**: Range-based window frames (vs current ROWS BETWEEN)
- [ ] **NTILE**: N-tile distribution functions
- [ ] **PERCENT_RANK/CUME_DIST**: Statistical ranking functions

**Schema & DDL Enhancements**
- [ ] **Foreign Key Constraints**: REFERENCES constraints with cascading actions
- [ ] **Computed Columns**: Columns with derived values
- [ ] **Schema Versioning**: Track schema changes and invalidate plans
- [ ] **ALTER TABLE**: More comprehensive ALTER TABLE operations
- [ ] **Materialized Views**: Views with cached results

## VII. Quality & Developer Experience

**Error Handling & Diagnostics**
- [ ] **Enhanced Error Messages**: Better error contexts with line numbers
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

## VIII. Future Architecture Evolution

**Advanced Features**
- [ ] **Distributed Queries**: Query federation across multiple data sources
- [ ] **Real-time Queries**: Streaming query execution over live data
- [ ] **Graph Queries**: Graph traversal and pattern matching capabilities
- [ ] **Machine Learning Integration**: Built-in ML functions and operators

**Ecosystem Integration**
- [ ] **Driver Development**: Native drivers for popular languages (Python, Java, etc.)
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

**Status Update:** Quereus has evolved significantly beyond the previous TODO assessment! The engine now has:

- **Complete JOIN support** with all major join types working
- **Comprehensive window functions** including frame specifications
- **Full constraint system** with operation-specific triggers
- **Complete set operations** (UNION, INTERSECT, EXCEPT)
- **Robust subquery support** including correlated subqueries
- **Full DISTINCT support** and advanced SQL features
- **Complete DDL support** including indexes and views

**Next Phase Focus:** The primary development focus should shift from implementing missing core SQL features (which are now largely complete) to **optimization, performance, and advanced features**. The engine has a solid foundation and can handle complex SQL workloads effectively.
