---
description: Comprehensive review plan for schema management subsystem
dependencies: none
priority: 3
---

# Schema Management Subsystem Review Plan

This document provides a comprehensive review plan for the schema management subsystem in the Quereus SQL query processor.

## Overview

The schema subsystem (`packages/quereus/src/schema/`) manages database metadata including tables, columns, indexes, views, functions, constraints, and triggers. This review will cover:

1. **Architecture Assessment**: Evaluate the overall design and integration points
2. **Code Quality Analysis**: Identify DRY violations, large functions, and maintainability issues  
3. **Test Coverage Gaps**: Identify missing unit and integration tests
4. **Documentation Review**: Assess API docs, code comments, and usage guides
5. **Defect Analysis**: Identify potential bugs, edge cases, and error handling issues

## Architecture Assessment

### Key Components (by file)

| File | Lines | Purpose | Critical |
|------|-------|---------|----------|
| `column.ts` | 213 | Column definitions and virtual column support | Yes |
| `constraint.ts` | 173 | Column/table constraints (PK, FK, UNIQUE, CHECK) | Yes |
| `ddl-executor.ts` | 563 | Schema-affecting statement execution | Yes |
| `declarative.ts` | 612 | Declarative schema diffing and migrations | Yes |
| `function.ts` | 179 | User-defined scalar function registration | Medium |
| `index.ts` | 147 | Index definitions and management | Medium |
| `schema.ts` | 384 | Main schema class and registry management | Yes |
| `table.ts` | 191 | Table class with column/constraint tracking | Yes |
| `trigger.ts` | 99 | Trigger definitions (BEFORE/AFTER/INSTEAD OF) | Low |
| `view.ts` | 51 | View definitions | Low |
| `assertion.ts` | 82 | Global assertions (CREATE ASSERTION) | Low |

### Integration Points to Review

1. **Schema → Planner**: How schema metadata flows to query planning
2. **Schema → Runtime**: How DDL execution modifies schema state
3. **Schema → Virtual Tables**: How VTab modules interact with schema
4. **Schema → Isolation Layer**: How schema changes participate in transactions

## Specific Issues Identified

### 1. Large Functions Needing Decomposition

**`declarative.ts:diffSchemas()`** (Lines ~150-400)
- Over 250 lines handling table, index, constraint, trigger diffing
- Deeply nested conditionals for different change types
- Should be split into: `diffTables()`, `diffIndexes()`, `diffConstraints()`, `diffTriggers()`

**`ddl-executor.ts:executeCreateTable()`** (Lines ~80-180)
- 100+ lines handling table creation with constraints
- Mixed concerns: validation, constraint processing, storage creation
- Should extract: `validateTableDefinition()`, `processConstraints()`, `createTableStorage()`

**`ddl-executor.ts:executeAlterTable()`** (Lines ~200-350)
- 150+ lines with complex switch statements for alter operations
- Should extract handlers per operation type: `addColumn()`, `dropColumn()`, `addConstraint()`, etc.

### 2. DRY Violations

**Constraint Creation Logic** (`constraint.ts` + `ddl-executor.ts`)
- Constraint normalization appears in both files
- Should consolidate into `constraint.ts` factory methods

**Column Definition Processing** (`column.ts` + `ddl-executor.ts`)
- Duplicate validation logic for column types and defaults
- Should have single source of truth in `column.ts`

**Index Processing** (`index.ts` + `declarative.ts`)
- Index comparison logic duplicated
- Should extract to shared utility in `index.ts`

### 3. Error Handling Issues

**`ddl-executor.ts`**:
- Many operations throw generic `Error` instead of `QuereusError`
- Missing error codes for schema-specific failures
- Inconsistent error messages (some include table name, some don't)

**`declarative.ts`**:
- Silent failures in diff detection (returns empty array vs throwing)
- Missing validation of schema state before diffing

### 4. Type Safety Concerns

**`schema.ts`**:
- Uses `Map<string, any>` for some internal registries
- Missing strict typing on schema event payloads

**`function.ts`**:
- Function signature validation at runtime only
- Could benefit from compile-time type inference

### 5. Memory/Performance Concerns

**`schema.ts`**:
- Table registry grows unbounded (no cleanup of dropped tables from history)
- No caching of frequently accessed metadata

**`declarative.ts`**:
- Full schema scan on every diff (no incremental tracking)
- Large schemas could be slow to diff

## Test Coverage Gaps

### Missing Unit Tests

**File: `constraint.ts`**
- Foreign key reference resolution
- Constraint name generation
- Constraint validation rules
- ON DELETE/UPDATE cascade behavior definitions

**File: `column.ts`**
- Virtual column expression parsing
- Default value coercion
- Column type validation
- Nullable inference from constraints

**File: `declarative.ts`**
- Circular dependency detection in migrations
- Conflict resolution strategies
- Partial schema diffs (subset of tables)
- Edge cases: empty schemas, single table, no changes

**File: `function.ts`**
- Function overload resolution
- Aggregate vs scalar function registration
- Function signature validation

### Missing Integration Tests

**Schema + DDL Execution**
- Full lifecycle: CREATE → ALTER → DROP sequences
- Concurrent schema modifications
- Schema rollback on constraint violations

**Schema + Transactions**
- Schema changes within transaction boundaries
- Schema visibility across transaction isolation levels
- Savepoint interactions with schema changes

**Schema + Virtual Tables**
- VTab registration and schema integration
- VTab schema refresh on underlying data changes

### Test Scenarios to Add

1. **Constraint Validation**
   - Create table with circular FK references → should fail
   - Create FK to non-existent table → should fail
   - Create duplicate constraint names → should fail
   - Create CHECK constraint with invalid expression → should fail

2. **Declarative Schema**
   - Apply schema with dropped columns containing data → should handle gracefully
   - Apply schema with type changes → should validate compatibility
   - Apply schema with renamed tables (via annotation) → should preserve data
   - Diff schemas with 100+ tables → performance test

3. **Concurrent Access**
   - Multiple connections modifying same table → should serialize
   - Schema read during DDL execution → should see consistent state
   - Schema cache invalidation across connections

## Documentation Gaps

### Missing/Incomplete Documentation

1. **`docs/schema.md`** - Needs:
   - Complete API reference for Schema class
   - Examples of programmatic schema manipulation
   - Error codes and handling guide
   - Schema event system documentation

2. **`docs/ddl.md`** - Needs:
   - Full DDL syntax reference
   - Constraint syntax and semantics
   - ALTER TABLE supported operations
   - Limitations and differences from SQLite

3. **`docs/declarative.md`** - Needs:
   - Migration strategy documentation
   - Diff algorithm explanation
   - Best practices for schema evolution
   - Examples of complex migrations

### Code Comments Needed

**`ddl-executor.ts`**:
- Function-level JSDoc for all exported functions
- Inline comments explaining constraint processing order
- Documentation of error conditions

**`declarative.ts`**:
- Algorithm documentation for diff logic
- Explanation of change ordering strategy
- Documentation of idempotency guarantees

## Refactoring Candidates

### High Priority

1. **Extract DDL Handlers** (`ddl-executor.ts`)
   ```
   Before: Single large executeStatement() with switch
   After: DDLHandlerRegistry with pluggable handlers per statement type
   ```
   - Improves testability (test each handler in isolation)
   - Enables extension (plugins can add DDL handlers)
   - Reduces cognitive load

2. **Consolidate Constraint Logic** (`constraint.ts`)
   ```
   Before: Constraint creation scattered across files
   After: ConstraintBuilder with validation, normalization, and creation
   ```
   - Single source of truth
   - Better error messages
   - Easier to add new constraint types

3. **Add Schema Event Types** (`schema.ts`)
   ```
   Before: Event payloads as any
   After: Typed SchemaEvent discriminated union
   ```
   - Type-safe event handling
   - Better IDE support
   - Prevents runtime errors

### Medium Priority

4. **Extract Diff Strategies** (`declarative.ts`)
   - Create separate classes for table/index/constraint/trigger diffing
   - Enable custom diff strategies for specific use cases

5. **Add Schema Validation Layer**
   - Centralized validation before any schema modification
   - Consistent error handling and messages

6. **Implement Schema Snapshots**
   - Enable schema versioning for point-in-time recovery
   - Support for schema history queries

## Files to Review with Specific Line Ranges

### Critical Review Areas

| File | Lines | Focus Area |
|------|-------|------------|
| `ddl-executor.ts` | 80-180 | CREATE TABLE logic |
| `ddl-executor.ts` | 200-350 | ALTER TABLE logic |
| `ddl-executor.ts` | 400-500 | Error handling patterns |
| `declarative.ts` | 150-400 | diffSchemas() decomposition |
| `declarative.ts` | 450-550 | applyDiff() safety |
| `schema.ts` | 50-150 | Registry management |
| `schema.ts` | 200-300 | Table lookup and caching |
| `constraint.ts` | 50-120 | Constraint creation |
| `constraint.ts` | 120-173 | FK reference resolution |
| `column.ts` | 80-150 | Virtual column handling |
| `column.ts` | 150-213 | Default value processing |

### Secondary Review Areas

| File | Lines | Focus Area |
|------|-------|------------|
| `function.ts` | 50-130 | Function registration |
| `index.ts` | 80-147 | Index validation |
| `table.ts` | 100-191 | Column/constraint tracking |
| `trigger.ts` | 40-99 | Trigger validation |
| `view.ts` | 20-51 | View definition storage |
| `assertion.ts` | 30-82 | Assertion management |

## TODO

### Phase 1: Code Quality Improvements
- [ ] Decompose `diffSchemas()` into focused helper functions
- [ ] Decompose `executeCreateTable()` into validation and creation phases
- [ ] Decompose `executeAlterTable()` into operation-specific handlers
- [ ] Consolidate constraint creation logic into `constraint.ts`
- [ ] Consolidate column validation logic into `column.ts`
- [ ] Replace generic `Error` throws with `QuereusError` and codes
- [ ] Add type safety to schema event payloads
- [ ] Add type safety to internal registries

### Phase 2: Test Coverage
- [ ] Add unit tests for `constraint.ts` (FK resolution, validation, naming)
- [ ] Add unit tests for `column.ts` (virtual columns, defaults, types)
- [ ] Add unit tests for `declarative.ts` (diff edge cases, circular deps)
- [ ] Add unit tests for `function.ts` (overloads, validation)
- [ ] Add integration tests for DDL lifecycle (CREATE → ALTER → DROP)
- [ ] Add integration tests for concurrent schema access
- [ ] Add integration tests for schema + transaction interaction
- [ ] Add performance tests for large schema diffs (100+ tables)

### Phase 3: Documentation
- [ ] Create/update `docs/schema.md` with full API reference
- [ ] Create/update `docs/ddl.md` with complete syntax reference
- [ ] Create/update `docs/declarative.md` with migration guide
- [ ] Add JSDoc to all exported functions in `ddl-executor.ts`
- [ ] Add algorithm documentation to `declarative.ts`
- [ ] Document error codes and conditions

### Phase 4: Refactoring
- [ ] Extract DDL handlers into pluggable registry
- [ ] Create ConstraintBuilder for consolidated constraint logic
- [ ] Add typed SchemaEvent system
- [ ] Extract diff strategies for declarative schema
- [ ] Implement centralized schema validation layer

### Phase 5: Performance/Memory
- [ ] Add schema metadata caching
- [ ] Implement incremental schema change tracking
- [ ] Add cleanup of dropped table history
- [ ] Profile and optimize large schema operations
