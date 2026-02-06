---
description: Plan comprehensive review of shared utilities (comparison, coercion, caching)
dependencies: none
priority: 3
---

# Shared Utilities Review Planning

Plan a thorough adversarial review of shared utility modules.

## Scope

Files in `packages/quereus/src/util/`:
- `comparison.ts` - SQL value comparison (compareSqlValues, compareRows)
- `coercion.ts` - Type coercion utilities
- `affinity.ts` - Type affinity rules
- `cached.ts` - Lazy caching utility
- `hash.ts` - Hashing utilities
- `serialization.ts` - Value serialization
- `sql-literal.ts` - SQL literal formatting
- `plan-formatter.ts` - Plan output formatting
- `patterns.ts` - Pattern matching utilities
- `event-support.ts` - Event infrastructure
- `latches.ts` - Synchronization primitives
- `plugin-helper.ts` - Plugin loading utilities
- `row-descriptor.ts` - Row descriptor utilities
- `mutation-statement.ts` - Mutation statement helpers
- `environment.ts` - Environment detection
- `working-table-iterable.ts` - Working table support

Files in `packages/quereus/src/common/`:
- `errors.ts` - Error classes and status codes
- `logger.ts` - Logging infrastructure
- `constants.ts` - Shared constants

## Review Objectives

The planned review tasks should:

1. **Architecture Review**
   - Utility cohesion and responsibilities
   - Cross-cutting concern isolation
   - Dependency direction (utilities → core)

2. **Code Quality Review**
   - Single purpose adherence
   - Functional style consistency
   - Error handling patterns
   - Type safety

3. **Test Coverage Assessment**
   - Comparison edge cases (NULL, mixed types)
   - Coercion completeness
   - Caching correctness
   - Pattern matching accuracy

4. **Defect Analysis**
   - Comparison inconsistencies
   - Coercion rule gaps
   - Cache invalidation bugs
   - Serialization roundtrip issues

## Output

This planning task produces detailed review tasks covering:
- Utility-by-utility verification
- Cross-utility consistency
- Performance characteristics
- Error handling robustness
