---
description: Comprehensive review of parser subsystem (lexer, parser, AST, visitor)
dependencies: none
priority: 3
---

# Parser Subsystem Review

## Overview

The parser subsystem consists of:
- **lexer.ts** (~810 lines): SQL tokenization with comprehensive keyword and operator support
- **parser.ts** (~3560 lines): Recursive descent parser - largest file, needs refactoring
- **ast.ts** (~609 lines): AST node type definitions - well-structured
- **visitor.ts** (~154 lines): AST visitor pattern implementation
- **utils.ts** (~10 lines): Minimal utility functions

## Architecture Assessment

### Strengths
- Clean separation between lexer and parser
- Comprehensive AST type system with proper location tracking
- Good error location reporting with line/column/offset information
- Visitor pattern properly implemented for AST traversal
- Support for complex SQL features (CTEs, window functions, declarative schema, UPSERT)

### Critical Issues

#### 1. Parser.ts Monolithic Structure
**File**: `packages/quereus/src/parser/parser.ts` (3560 lines, 96 methods)
**Problem**: Single massive file violates single responsibility principle
**Impact**: Hard to maintain, test, and understand

**Refactoring Candidates**:
- Extract expression parsing (lines 1139-1760) → `parser-expressions.ts`
  - Methods: `expression()`, `logicalXorOr()`, `logicalAnd()`, `isNull()`, `equality()`, `comparison()`, `term()`, `factor()`, `concatenation()`, `collateExpression()`, `primary()`
  - ~620 lines, 11 methods
  
- Extract DDL parsing (lines 2104-2811) → `parser-ddl.ts`
  - Methods: `createStatement()`, `createTableStatement()`, `createIndexStatement()`, `createViewStatement()`, `createAssertionStatement()`, `dropStatement()`, `alterTableStatement()`, `declareSchemaStatement()`, `diffSchemaStatement()`, `applySchemaStatement()`, `explainSchemaStatement()`
  - ~707 lines, 11 methods
  
- Extract DML parsing (lines 322-2081) → `parser-dml.ts`
  - Methods: `insertStatement()`, `updateStatement()`, `deleteStatement()`, `selectStatement()`, `valuesStatement()`, `parseUpsertClause()`
  - ~760 lines, 6 methods
  
- Extract transaction/control parsing (lines 2449-2513) → `parser-control.ts`
  - Methods: `beginStatement()`, `commitStatement()`, `rollbackStatement()`, `savepointStatement()`, `releaseStatement()`, `pragmaStatement()`
  - ~64 lines, 6 methods
  
- Extract helper methods (lines 1858-3104) → `parser-helpers.ts`
  - Methods: `match()`, `consume()`, `check()`, `checkNext()`, `advance()`, `peek()`, `previous()`, `error()`, `isJoinToken()`, `isEndOfClause()`, `consumeIdentifier()`, `consumeIdentifierOrContextualKeyword()`, `checkIdentifierLike()`, `columnDefinition()`, `parseMutationContextDefinitions()`, `parseContextAssignments()`, `parseSchemaPath()`, `indexedColumnList()`, `indexedColumn()`, `getIdentifierValue()`, `consumeBooleanLiteral()`, `nameValueItem()`, `sourceSlice()`
  - ~250 lines, 23 methods

#### 2. Debug Logging Left in Production Code
**File**: `packages/quereus/src/parser/parser.ts`
**Lines**: 695, 710, 712, 739, 742
**Problem**: Debug logging statements in `columnList()` method
**Fix**: Remove or gate behind DEBUG environment variable

#### 3. Code Duplication in Expression Parsing
**File**: `packages/quereus/src/parser/parser.ts`
**Lines**: 1146-1164, 1169-1187, 1221-1248
**Problem**: Repeated pattern for binary operator parsing
**Refactoring**: Extract to generic `parseBinaryOperator()` helper

#### 4. Location Token Lookup Inefficiency
**File**: `packages/quereus/src/parser/parser.ts`
**Lines**: 1148, 1171, 1194, 1223, etc.
**Problem**: Repeated `this.tokens.find(t => t.startOffset === expr.loc!.start.offset)` pattern
**Impact**: O(n) lookup on every expression node creation
**Fix**: Cache token-to-index mapping or pass tokens explicitly

#### 5. Inconsistent Error Message Formatting
**File**: `packages/quereus/src/parser/parser.ts`
**Lines**: 1937-1966
**Problem**: Error hints are hardcoded in `error()` method
**Fix**: Extract error message generation to separate module with context-aware hints

## Code Quality Issues

### DRY Violations

1. **Identifier Parsing** (lines 2925-2967)
   - `consumeIdentifier()` has two overloads with similar logic
   - `consumeIdentifierOrContextualKeyword()` duplicates identifier parsing
   - **Fix**: Consolidate into single parameterized method

2. **Contextual Keyword Checking** (lines 2968-3019)
   - `checkIdentifierLike()` and `checkIdentifierLikeAt()` duplicate logic
   - `isContextualKeywordAvailable()` has similar pattern
   - **Fix**: Extract shared logic to helper

3. **Statement Parsing Pattern** (multiple locations)
   - All statement methods follow: `startToken = advance()`, parse body, `endToken = previous()`, return with `loc: _createLoc(startToken, endToken)`
   - **Fix**: Extract to `parseStatementWithLocation<T>()` helper

### Large Functions

1. **`selectStatement()`** (lines 524-689, ~165 lines)
   - Handles SELECT, FROM, WHERE, GROUP BY, HAVING, ORDER BY, LIMIT, OFFSET, UNION/INTERSECT/EXCEPT
   - **Refactoring**: Extract clause parsers: `parseSelectClauses()`, `parseFromClause()`, `parseWhereClause()`, etc.

2. **`primary()`** (lines 1539-1761, ~222 lines)
   - Handles literals, identifiers, columns, functions, casts, subqueries, CASE, IN, EXISTS, BETWEEN, parameters, window functions
   - **Refactoring**: Extract sub-parsers: `parseLiteral()`, `parseFunctionCall()`, `parseSubquery()`, `parseCaseExpr()`, etc.

3. **`createTableStatement()`** (lines 2129-2241, ~112 lines)
   - Handles table creation with columns, constraints, USING clause, WITH CONTEXT
   - **Refactoring**: Extract: `parseColumnDefinitions()`, `parseTableConstraints()`, `parseUsingClause()`, `parseContextClause()`

### Expressiveness Issues

1. **Backtracking in `isNull()`** (lines 1211-1212)
   - Manual backtracking is error-prone
   - **Fix**: Use lookahead pattern or restructure to avoid backtracking

2. **Complex Conditional Logic** (lines 728-735)
   - Hard to understand implicit alias detection
   - **Fix**: Extract to `canBeImplicitAlias()` method with clear name

## Test Coverage Gaps

### Missing Unit Tests

**Current State**: Tests are primarily integration tests via `.sqllogic` files. No dedicated parser unit tests exist.

**Needed Tests**:

1. **Lexer Edge Cases** (`test/parser/lexer.spec.ts`)
   - Unicode identifiers and strings
   - Very long identifiers (>1000 chars)
   - Nested comments (/* /* */ */)
   - Unterminated strings/blobs/comments
   - Invalid blob hex digits
   - Scientific notation edge cases (1e+100, 1e-100)
   - Parameter parsing (? vs :name vs $name)

2. **Parser Error Recovery** (`test/parser/errors.spec.ts`)
   - Unterminated parentheses with location tracking
   - Missing commas in column lists
   - Invalid operator combinations
   - Keyword in wrong context
   - Malformed expressions (e.g., `SELECT * FROM WHERE`)
   - Error message quality verification

3. **Expression Parsing** (`test/parser/expressions.spec.ts`)
   - Operator precedence correctness
   - Associativity (left vs right)
   - Parenthesized expressions
   - Complex nested expressions
   - Edge cases: `-(-1)`, `NOT NOT TRUE`, `1 + 2 * 3`

4. **AST Location Tracking** (`test/parser/locations.spec.ts`)
   - Verify `loc` property on all AST nodes
   - Multi-line statement location accuracy
   - Location preservation through transformations

5. **Statement Parsing** (`test/parser/statements.spec.ts`)
   - All statement types with minimal valid syntax
   - Optional clauses (WITH, WHERE, ORDER BY, etc.)
   - Edge cases: empty SELECT, SELECT without FROM

### Integration Test Gaps

Review `test/logic/*.sqllogic` files for missing coverage:
- [ ] Parser stress tests (very large statements)
- [ ] Unicode handling in all contexts
- [ ] Error message quality tests
- [ ] Performance tests (parsing time for large queries)

## Documentation Gaps

### Missing Documentation

1. **Parser Architecture Document** (`docs/parser.md`)
   - Parser design philosophy
   - Expression precedence table
   - Error recovery strategy
   - Location tracking implementation
   - Extension points for new SQL features

2. **AST Reference** (`docs/ast.md`)
   - Complete AST node reference
   - Node type relationships
   - Location property usage
   - Visitor pattern examples

3. **SQL Syntax Reference** (`docs/sql.md` - needs parser section)
   - Supported SQL syntax
   - Quereus-specific extensions
   - Known limitations
   - Migration guide from SQLite/PostgreSQL

4. **Code Comments**
   - Many parser methods lack JSDoc comments
   - Complex parsing logic needs inline comments
   - Expression precedence needs documentation

## Files to Review

### High Priority
- `packages/quereus/src/parser/parser.ts` (lines 1-3560) - **CRITICAL**: Monolithic file needs decomposition
- `packages/quereus/src/parser/lexer.ts` (lines 1-810) - Review for edge cases and error handling

### Medium Priority  
- `packages/quereus/src/parser/ast.ts` (lines 1-609) - Verify type completeness and consistency
- `packages/quereus/src/parser/visitor.ts` (lines 1-154) - Check for missing node type handlers

### Low Priority
- `packages/quereus/src/parser/utils.ts` (lines 1-10) - Minimal, likely fine
- `packages/quereus/src/parser/index.ts` (lines 1-64) - Public API, review exports

## TODO

### Phase 1: Immediate Cleanup
- [ ] Remove debug logging from `columnList()` (lines 695, 710, 712, 739, 742)
- [ ] Address TODOs in parser.ts (lines 253, 292) and visitor.ts (line 154)
- [ ] Extract binary operator parsing helper to eliminate duplication
- [ ] Fix backtracking in `isNull()` method (lines 1211-1212)

### Phase 2: File Decomposition  
- [ ] Extract expression parsing to `parser-expressions.ts` (~620 lines, 11 methods)
- [ ] Extract DDL parsing to `parser-ddl.ts` (~707 lines, 11 methods)
- [ ] Extract DML parsing to `parser-dml.ts` (~760 lines, 6 methods)
- [ ] Extract control statements to `parser-control.ts` (~64 lines, 6 methods)
- [ ] Extract helpers to `parser-helpers.ts` (~250 lines, 23 methods)
- [ ] Update all imports and exports

### Phase 3: Code Quality
- [ ] Consolidate identifier parsing methods (lines 2925-2967)
- [ ] Extract statement location helper to reduce duplication
- [ ] Optimize location token lookups (cache token index mapping)
- [ ] Refactor `selectStatement()` into clause parsers
- [ ] Refactor `primary()` into sub-parsers  
- [ ] Refactor `createTableStatement()` into component parsers
- [ ] Extract error message generation to `parser-errors.ts`
- [ ] Extract `canBeImplicitAlias()` helper (lines 728-735)

### Phase 4: Testing
- [ ] Create `test/parser/lexer.spec.ts` with comprehensive lexer tests
- [ ] Create `test/parser/parser.spec.ts` with statement and expression tests
- [ ] Create `test/parser/errors.spec.ts` for error handling verification
- [ ] Create `test/parser/locations.spec.ts` for AST location accuracy
- [ ] Review `.sqllogic` files for parser test coverage gaps
- [ ] Add parser performance/stress tests

### Phase 5: Documentation
- [ ] Create `docs/parser.md` with architecture documentation
- [ ] Create `docs/ast.md` with AST node reference
- [ ] Add parser section to `docs/sql.md`
- [ ] Add JSDoc comments to all parser methods
- [ ] Document expression precedence table
- [ ] Add inline comments for complex parsing logic
