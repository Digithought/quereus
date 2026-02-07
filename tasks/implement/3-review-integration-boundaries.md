---
description: Comprehensive review of integration boundaries between subsystems
dependencies: none
priority: 3
---

# Integration Boundaries Review Plan

This document provides a comprehensive adversarial review plan for the integration boundaries between subsystems in the Quereus SQL query processor.

## 1. Scope

The integration review covers boundaries between:

- Note: unless otherwise specified, file paths in this document are relative to `packages/quereus/`.
- **Parser → Planner**: AST to plan tree transformation
- **Planner → Optimizer**: Plan node manipulation
- **Optimizer → Runtime**: Plan to execution instructions
- **Runtime → VTab**: Execution to data access
- **Schema → All Layers**: Metadata access patterns
- **Core API → All Layers**: Public API boundaries

## 2. Integration Boundary Inventory

### Boundary 1: Parser → Planner

**Interface:**
- Input: SQL string
- Output: AST (Abstract Syntax Tree)
- Handoff point: `parse()` function → `planStatement()`

**Data structures:**
- AST node types (`src/parser/ast.ts`)
- Location information
- Literal values

**Concerns:**
- AST completeness for all SQL features
- Location preservation through planning
- Type information from literals

### Boundary 2: Planner → Optimizer

**Interface:**
- Input: Logical plan tree
- Output: Optimized plan tree
- Handoff point: `planStatement()` → `optimize()`

**Data structures:**
- PlanNode types (`src/planner/nodes.ts`)
- Attributes and attribute IDs
- RelationType (row types)

**Concerns:**
- Plan node immutability
- Attribute ID stability through optimization
- Physical properties propagation

### Boundary 3: Optimizer → Runtime

**Interface:**
- Input: Optimized plan tree
- Output: Executable instructions
- Handoff point: `optimize()` → `emit()`

**Data structures:**
- Instructions (`src/runtime/instructions.ts`)
- Execution context
- Runtime values

**Concerns:**
- Complete translation of all plan nodes
- Context management
- Resource allocation

### Boundary 4: Runtime → VTab

**Interface:**
- Input: Query constraints, table reference
- Output: Row iterator
- Handoff point: Emitter → VTab module

**Data structures:**
- VTab interfaces (`src/vtab/types.ts`)
- Constraint info
- Index info

**Concerns:**
- Constraint pushdown accuracy
- Cursor lifecycle management
- Error propagation

### Boundary 5: Schema → All Layers

**Interface:**
- Input: Table/column/function names
- Output: Schema metadata
- Access points: Throughout all layers

**Data structures:**
- Schema, Table, Column, Constraint
- Function signatures
- Index definitions

**Concerns:**
- Consistency across layers
- Cache invalidation
- Transaction visibility

### Boundary 6: Core API → Internal

**Interface:**
- Input: User API calls
- Output: Internal operations
- Entry points: Database, Statement classes

**Data structures:**
- SqlValue, Parameters
- Results, Row objects
- Events

**Concerns:**
- Error message quality
- Type safety at boundary
- Resource management

## 3. Cross-Cutting Concerns

### Type System Consistency

**Review points:**
- Type representation in each layer
- Type coercion at boundaries
- NULL handling consistency

### Error Handling Across Boundaries

**Review points:**
- Error type translation
- Context preservation
- Recovery behavior

### Resource Management

**Review points:**
- Ownership transfer
- Cleanup responsibility
- Leak prevention

### Async Boundaries

**Review points:**
- Promise handling
- Generator/iterator handoff
- Cancellation propagation

## 4. Specific Files to Review

### Parser → Planner Boundary

**`src/parser/ast.ts`** - AST definitions
- All statement node types
- Expression node types
- Complete vs partial coverage

**`src/planner/planner.ts`** - Plan entry
- Lines handling each AST node type
- Validation of AST structure
- Error handling for unsupported AST

### Planner → Optimizer Boundary

**`src/planner/nodes.ts`** - Plan nodes
- All plan node types
- Required vs optional fields
- Immutability enforcement

**`src/optimizer/optimizer.ts`** - Optimization entry
- Plan tree traversal
- Rule application order
- Output validation

### Optimizer → Runtime Boundary

**`src/runtime/emitters/`** - All emitter files
- Coverage of all plan node types
- Context handling
- Resource allocation

**`src/runtime/instructions.ts`** - Instruction types
- Instruction completeness
- Execution contract

### Runtime → VTab Boundary

**`src/vtab/types.ts`** - VTab interface
- Interface completeness
- Method contracts
- Error handling requirements

**`src/runtime/emitters/table-scan.ts`** - VTab interaction
- Constraint translation
- Cursor management
- Error handling

### Schema Boundaries

**`src/schema/schema.ts`** - Schema access
- Thread safety (if applicable)
- Cache consistency
- Transaction visibility

**Usage in other layers:**
- Planner schema access patterns
- Runtime schema access patterns
- VTab schema integration

### API Boundaries

**`src/core/database.ts`** - Public API
- Input validation
- Output formatting
- Error translation

**`src/core/statement.ts`** - Statement API
- Parameter binding
- Result handling
- Lifecycle management

## 5. Integration Tests Needed

### Parser → Planner Integration

```typescript
// test/integration/parser-planner.spec.ts
describe('Parser → Planner integration', () => {
  it('handles all statement types')
  it('preserves source locations')
  it('handles edge case syntax')
  it('reports clear errors for unsupported features')
})
```

### Planner → Optimizer Integration

```typescript
// test/integration/planner-optimizer.spec.ts
describe('Planner → Optimizer integration', () => {
  it('preserves plan semantics')
  it('maintains attribute ID stability')
  it('handles all plan node types')
  it('gracefully handles optimization failures')
})
```

### Optimizer → Runtime Integration

```typescript
// test/integration/optimizer-runtime.spec.ts
describe('Optimizer → Runtime integration', () => {
  it('emits correct instructions for all plans')
  it('handles execution context correctly')
  it('propagates errors with context')
  it('cleans up resources on error')
})
```

### Runtime → VTab Integration

```typescript
// test/integration/runtime-vtab.spec.ts
describe('Runtime → VTab integration', () => {
  it('correctly pushes constraints')
  it('handles cursor lifecycle')
  it('propagates VTab errors')
  it('respects transaction boundaries')
})
```

### End-to-End Integration

```typescript
// test/integration/end-to-end.spec.ts
describe('End-to-end integration', () => {
  it('executes simple queries correctly')
  it('executes complex queries correctly')
  it('handles errors at each layer')
  it('maintains data consistency')
})
```

## 6. Contract Verification

### Interface Contracts to Document

1. **AST Contract**
   - Required fields per node type
   - Location information format
   - Value encoding

2. **PlanNode Contract**
   - Required fields per node type
   - Immutability rules
   - Attribute ID semantics

3. **Instruction Contract**
   - Execution environment
   - Input/output expectations
   - Error handling

4. **VTab Contract**
   - Method call order
   - Constraint format
   - Result expectations

### Contract Violations to Find

Search for:
- Accessing fields that may be undefined
- Assuming specific order of operations
- Missing error handling at boundaries
- Type mismatches across boundaries

## 7. Refactoring Candidates

### High Priority

1. **Define Clear Interface Types**
   ```typescript
   // Explicit boundary interfaces
   interface ParserOutput { ast: Statement; errors: ParseError[] }
   interface PlannerOutput { plan: PlanNode; metadata: PlanMetadata }
   interface OptimizerOutput { plan: PlanNode; stats: OptimizeStats }
   ```

2. **Add Boundary Validation**
   ```typescript
   // Validate at each boundary
   function validateAST(ast: Statement): ValidationResult
   function validatePlan(plan: PlanNode): ValidationResult
   ```

3. **Standardize Error Propagation**
   ```typescript
   // Wrap errors at boundaries with context
   function wrapParserError(e: Error, sql: string): QuereusError
   function wrapPlannerError(e: Error, ast: Statement): QuereusError
   ```

### Medium Priority

4. **Create Adapter Layers**
   - Isolate interface changes
   - Enable easier testing
   - Support versioning

5. **Add Tracing Infrastructure**
   - Trace data across boundaries
   - Debug complex issues
   - Performance analysis

### Lower Priority

6. **Interface Versioning**
   - Support for evolution
   - Backwards compatibility
   - Migration paths

## 8. Acceptance Criteria

### Boundaries Documented
- [ ] All 6 boundaries have documented interfaces
- [ ] Data structure contracts specified (required vs optional fields)
- [ ] Error handling expectations documented per boundary
- [ ] Boundary diagrams created showing data flow

### Boundaries Validated
- [ ] AST validation catches invalid structures before planner
- [ ] Plan validation catches invalid plans before optimizer
- [ ] Instruction validation catches invalid instructions before runtime
- [ ] Constraint validation catches invalid constraints before VTab

### Boundaries Tested
- [ ] Integration tests cover all boundary transitions
- [ ] Error propagation tested at each boundary
- [ ] Type safety verified at each boundary
- [ ] Resource management verified at each boundary

### Boundaries Type-Safe
- [ ] No unsafe type assertions at boundaries
- [ ] Type guards validate data at boundaries
- [ ] TypeScript types match runtime contracts
- [ ] Runtime type checking where needed

## 9. Test Plan

### Integration Tests
- [ ] Parser → Planner: All AST types handled (`test/integration/parser-planner.spec.ts`)
- [ ] Planner → Optimizer: Attribute ID stability (`test/integration/planner-optimizer.spec.ts`)
- [ ] Optimizer → Runtime: All plan nodes emit instructions (`test/integration/optimizer-runtime.spec.ts`)
- [ ] Runtime → VTab: Constraint pushdown correct (`test/integration/runtime-vtab.spec.ts`)
- [ ] End-to-end: Full query pipeline (`test/integration/end-to-end.spec.ts`)

### Boundary Validation Tests
- [ ] AST validation rejects invalid structures
- [ ] Plan validation rejects invalid plans
- [ ] Instruction validation rejects invalid instructions
- [ ] Constraint validation rejects invalid constraints

### Error Propagation Tests
- [ ] Errors propagate correctly across each boundary
- [ ] Error context preserved at each boundary
- [ ] Error wrapping adds appropriate context
- [ ] No information loss in error translation

## 10. TODO

### Phase 1: Documentation
- [ ] Document all 6 boundary interfaces (see section 2)
  - Parser → Planner: AST contract
  - Planner → Optimizer: PlanNode contract
  - Optimizer → Runtime: Instruction contract
  - Runtime → VTab: VTab contract
  - Schema → All: Schema access contract
  - Core API → Internal: API contract
- [ ] Document data structure contracts (required fields, invariants)
- [ ] Document error handling expectations (error types, context)
- [ ] Create boundary diagrams (Mermaid or similar)

### Phase 2: Validation
- [ ] Add AST validation at parser output (`validateAST()` function)
- [ ] Add plan validation at planner output (`validatePlan()` function)
- [ ] Add instruction validation at emitter output (`validateInstructions()` function)
- [ ] Add constraint validation at VTab boundary (`validateConstraints()` function)

### Phase 3: Testing
- [ ] Create parser-planner integration tests (see section 5)
- [ ] Create planner-optimizer integration tests (attribute ID stability)
- [ ] Create optimizer-runtime integration tests (instruction correctness)
- [ ] Create runtime-VTab integration tests (constraint pushdown)
- [ ] Create end-to-end integration tests (full pipeline)

### Phase 4: Error Handling
- [ ] Standardize error propagation (see `3-review-error-handling.md`)
- [ ] Add context at each boundary (SQL, AST, plan, etc.)
- [ ] Ensure no information loss (preserve original errors)
- [ ] Add error translation where needed (wrap with boundary context)

### Phase 5: Refactoring
- [ ] Define explicit interface types (see section 7)
- [ ] Add boundary validation functions (see Phase 2)
- [ ] Create adapter layers if beneficial (isolate changes)
- [ ] Add tracing infrastructure (debug boundary crossings)

### Phase 6: Type Safety
- [ ] Review type consistency (compare types across boundaries)
- [ ] Add type guards at boundaries (`isValidAST`, `isValidPlan`, etc.)
- [ ] Eliminate unsafe type assertions (`as any`, `as unknown`)
- [ ] Add runtime type checking where needed (validate at runtime)
