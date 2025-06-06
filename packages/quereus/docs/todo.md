## Project TODO List & Future Work

This list reflects the **current state** of Quereus - a surprisingly complete SQL query processor with the Titan runtime. Many core features are already implemented!

## I. Type System & Coercion ✅ (Mostly Complete)

**Type Coercion**
- [X] **Binary Operations**: All comparison and arithmetic operators ✅
- [X] **Aggregate Functions**: Context-aware coercion (SUM vs COUNT vs JSON) ✅
- [X] **Unary Operations**: NOT, IS NULL, unary +/-, bitwise operators ✅  
- [X] **CAST Operations**: Full explicit type conversion ✅
- [ ] **Built-in Scalar Functions**: Apply coercion to functions expecting numeric inputs
- [ ] **ORDER BY**: Numeric sorting of string columns using coercion

**Type Affinity & Storage**
- [ ] **INSERT Type Affinity**: Column type affinity during INSERT operations
- [ ] **Column Constraints**: NOT NULL, CHECK constraints with proper type coercion

## II. Core SQL Features ✅ (Complete!)

**SELECT Operations**
- [X] **Basic SELECT**: Project, Filter, Sort, Distinct, Limit/Offset ✅
- [X] **Aggregate Queries**: GROUP BY, HAVING, all aggregate functions ✅
- [X] **Window Functions**: Comprehensive Phase 1 implementation with ranking and aggregate functions ✅
- [X] **Set Operations**: UNION, INTERSECT, EXCEPT (all variants) ✅

**FROM Clause**
- [X] **Table References**: Full table and alias support ✅
- [X] **Subqueries**: Scalar subqueries, correlated subqueries ✅
- [X] **CTEs**: Both regular and recursive WITH support ✅
- [X] **Table-Valued Functions**: Complete TVF framework ✅

**DML Operations** 
- [X] **INSERT**: Multi-row, INSERT...SELECT, with RETURNING ✅
- [X] **UPDATE**: Full UPDATE with assignments, with RETURNING ✅
- [X] **DELETE**: Full DELETE with predicates, with RETURNING ✅

**DDL Operations**
- [X] **CREATE/DROP TABLE**: Full table management ✅
- [X] **CREATE/DROP VIEW**: Full view support ✅

**Advanced SQL**
- [X] **CASE Expressions**: Both simple and searched CASE ✅
- [X] **Scalar Functions**: Complete function call framework ✅
- [X] **Parameter References**: Named and positional parameters ✅
- [X] **Transaction Control**: BEGIN, COMMIT, ROLLBACK, SAVEPOINT ✅

## III. Runtime Architecture ✅ (Titan is Working!)

**Query Execution**
- [X] **Instruction Scheduling**: Async instruction execution ✅
- [X] **Context Management**: Row descriptors and attribute resolution ✅
- [X] **Stream Processing**: Efficient async iterator patterns ✅
- [X] **Memory Management**: Proper context cleanup and resource management ✅

**Query Planning**
- [X] **Physical Plans**: Complete planner → emitter → runtime pipeline ✅
- [X] **Correlation Handling**: Correlated subqueries working correctly ✅
- [ ] **Cost-Based Optimization**: Better cost estimates for plan selection
- [ ] **Join Reordering**: Optimize join order (joins not yet implemented)

## IV. Virtual Table Framework ✅ (Robust!)

**Core VTab Support**
- [X] **xConnect/xQuery**: Full table scan and query support ✅
- [X] **xUpdate**: INSERT/UPDATE/DELETE operations ✅ 
- [X] **Transaction Integration**: VTab transaction coordination ✅
- [X] **Connection Management**: Proper connection lifecycle ✅

**MemoryTable Improvements**
- [P] **Constraint Optimization**: Better xBestIndex for LIKE, GLOB, IN, ranges
- [P] **Transaction Performance**: Optimize layer cursor merge operations

## V. Missing Core Features (The Real TODOs)

**JOIN Operations** 
- [ ] **INNER/LEFT/RIGHT JOIN**: Basic join support (major gap!)
  - [ ] **JOIN Planning**: Implement planning for various `JOIN` types, creating `JoinNode`s
  - [ ] **JOIN Emitters**: Create `emitJoin` for `JoinNode` with proper attribute handling for both sides
  - [ ] **Join Condition Planning**: Handle join conditions and updating scopes correctly across join boundaries
- [ ] **JOIN Optimization**: Join reordering and optimization
- [ ] **CROSS JOIN**: Cartesian product support

**Window Functions** ✅ (Phase 1 Complete!)
- [X] **Ranking Functions**: ROW_NUMBER, RANK, DENSE_RANK, NTILE ✅
- [X] **Windowed Aggregates**: COUNT, SUM, AVG, MIN, MAX with OVER clauses ✅
- [X] **PARTITION BY**: Full partitioning support with proper execution strategies ✅
- [X] **Registration System**: Extensible window function registration like scalar/aggregate functions ✅
- [X] **Performance Optimization**: Groups functions by window specifications for efficiency ✅
- [ ] **LAG/LEAD**: Offset functions (Phase 2)
- [ ] **FIRST_VALUE/LAST_VALUE**: Navigation functions (Phase 2)
- [ ] **Window Frames**: ROWS BETWEEN, RANGE BETWEEN support (Phase 3)

**Advanced Subquery Support**
- [ ] **Correlated Subqueries**: Enhanced support for complex correlated subquery patterns
- [X] **EXISTS/NOT EXISTS**: Full implementation of EXISTS subquery conditions ✅
- [ ] **Scalar Subqueries**: Complete scalar subquery support in expressions

**Missing Scalar Operations**
- [ ] **UnaryOpNode**: Complete implementation for unary operations
- [ ] **CastNode**: Enhanced casting operations
- [ ] **CollateNode**: Full collation support
- [ ] **CaseExprNode**: Complete CASE expression handling

**Advanced SQL Features**
- [ ] **DISTINCT**: Implement support for `SELECT DISTINCT`
- [ ] **Set Operations**: UNION, INTERSECT, EXCEPT with proper attribute handling
- [ ] **Recursive Queries**: More robust WITH RECURSIVE implementation

## VI. Polish & Optimization

**Query Optimization Enhancements**
- [ ] **Index Selection**: Implement `TableSeekNode` for indexed access and enhance cost-based optimization
- [ ] **Join Optimization**: Join reordering and optimal join algorithm selection  
- [ ] **Predicate Pushdown**: Advanced predicate pushdown optimizations
- [ ] **Cost-Based Planning**: Better cost estimates for plan selection

**Performance**
- [ ] **Index Usage**: Better index selection recommendations
- [ ] **Query Caching**: Result caching and invalidation
- [ ] **Memory Pooling**: Reduce allocation overhead in hot paths

**Schema and Constraint Enhancements**
- [ ] **DDL Operations**: Enhanced `CREATE TABLE`/`DROP TABLE`/`CREATE INDEX`/`DROP INDEX` support
- [ ] **Constraint Enforcement**: Integration of CHECK constraints and foreign key validation
- [ ] **Emission Context**: Introduce emission context for compile-time schema lookups rather than runtime lookups
- [ ] **Schema Versioning**: Implement schema versioning to invalidate plans when schema changes

**Error Handling** 
- [ ] **Better Error Messages**: More descriptive error contexts; line numbers on everything that supports it
- [ ] **Error Recovery**: Better parser/runtime error recovery
- [ ] **Constraint Violations**: Proper constraint error handling

**Testing & Quality**
- [ ] **JOIN Test Coverage**: Comprehensive join testing once implemented
- [ ] **Performance Benchmarks**: Regression testing for performance  
- [ ] **Edge Case Testing**: Boundary conditions and error cases

## VII. Future Enhancements

**Developer Tools & Debugging**
- [ ] **Plan Serialization**: Implement mechanisms to serialize `PlanNode` trees for debugging and analysis
- [ ] **Query Visualization**: Develop tools to visualize query plans and execution flow
- [ ] **Performance Profiling**: Enhanced debugging capabilities with detailed performance profiling

**Ecosystem Integration**
- [ ] **Driver Development**: Native drivers for popular languages
- [ ] **ORM Integration**: Adapters for TypeScript/JavaScript ORMs
- [ ] **Cloud Integration**: Cloud-native deployment options

**Advanced Features**
- [ ] **Alternative Backends**: Explore targeting different execution backends while maintaining the attribute-based architecture
- [ ] **Distributed Queries**: Query federation across data sources
- [ ] **Real-time Queries**: Streaming query execution

---

**Legend:**
- `[ ]`: Not Started
- `[P]`: Partially Implemented / In Progress  
- `[X]`: Completed ✅

**Key Insight:** Quereus has a **robust, modern architecture** with comprehensive SQL support! The attribute-based context system provides excellent stability across plan transformations. The primary remaining gap is **JOIN operations** - the basic infrastructure is complete (qualified column name resolution works!), just needs the JOIN node implementation. Once implemented, this becomes a very capable SQL engine.
