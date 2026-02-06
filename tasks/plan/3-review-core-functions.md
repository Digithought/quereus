---
description: Plan comprehensive review of built-in functions (scalar, aggregate, window, JSON)
dependencies: none
priority: 3
---

# Built-in Functions Review Planning

Plan a thorough adversarial review of built-in SQL functions.

## Scope

Files in `packages/quereus/src/func/`:
- `registration.ts` - Function registration infrastructure
- `context.ts` - Function evaluation context
- `builtins/index.ts` - Built-in function exports

Scalar functions in `builtins/`:
- `scalar.ts` - Core scalar functions (lower, upper, length, etc.)
- `string.ts` - String functions (substr, trim, etc.)
- `conversion.ts` - Type conversion functions
- `datetime.ts` - Date/time functions
- `generation.ts` - Generation functions (random, etc.)
- `timespan.ts` - Timespan utilities

Aggregate functions:
- `aggregate.ts` - COUNT, SUM, AVG, MIN, MAX, GROUP_CONCAT

Window functions:
- `builtin-window-functions.ts` - ROW_NUMBER, RANK, etc.

JSON functions:
- `json.ts` - json_extract, json_set, etc.
- `json-helpers.ts` - JSON utilities
- `json-tvf.ts` - JSON table-valued functions

Introspection:
- `explain.ts` - query_plan, scheduler_program, etc.
- `schema.ts` - Schema introspection functions

Documentation:
- `docs/functions.md`

## Review Objectives

The planned review tasks should:

1. **Architecture Review**
   - Function registration consistency
   - Determinism flag accuracy
   - Null handling uniformity
   - Overload resolution

2. **Code Quality Review**
   - Function implementation clarity
   - Error handling consistency
   - Parameter validation patterns
   - Code reuse across similar functions

3. **Test Coverage Assessment**
   - Boundary value tests for each function
   - Null argument handling
   - Type coercion behavior
   - Error condition tests

4. **Defect Analysis**
   - Edge cases in string functions (empty, unicode)
   - Numeric overflow in aggregates
   - Date/time boundary cases
   - JSON function edge cases

## Output

This planning task produces detailed review tasks covering:
- Function-by-function correctness verification
- Comprehensive boundary testing
- Documentation-implementation alignment
- Performance characteristics review
