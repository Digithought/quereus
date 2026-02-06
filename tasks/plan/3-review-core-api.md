---
description: Plan comprehensive review of core API (Database, Statement classes)
dependencies: none
priority: 3
---

# Core API Review Planning

Plan a thorough adversarial review of the public Database and Statement APIs.

## Scope

Files in `packages/quereus/src/core/`:
- `database.ts` - Main Database class
- `database-options.ts` - Database configuration
- `database-transaction.ts` - Transaction management
- `database-assertions.ts` - Assertion management
- `database-events.ts` - Event emission
- `database-internal.ts` - Internal helpers
- `statement.ts` - Prepared statement class
- `param.ts` - Parameter binding
- `utils.ts` - Core utilities

Files in `packages/quereus/src/`:
- `index.ts` - Public API exports

Documentation:
- `docs/usage.md`

## Review Objectives

The planned review tasks should:

1. **Architecture Review**
   - Database lifecycle management
   - Statement caching and invalidation
   - Transaction state machine
   - Event subscription model

2. **Code Quality Review**
   - API surface clarity and consistency
   - Error handling and propagation
   - Resource cleanup guarantees
   - Method naming conventions

3. **Test Coverage Assessment**
   - API contract tests
   - Transaction boundary tests
   - Concurrent usage patterns
   - Resource leak detection

4. **Defect Analysis**
   - Statement leak potential
   - Transaction state corruption
   - Event delivery guarantees
   - Shutdown cleanup completeness

## Output

This planning task produces detailed review tasks covering:
- API ergonomics evaluation
- Resource lifecycle verification
- Transaction robustness tests
- Documentation accuracy
