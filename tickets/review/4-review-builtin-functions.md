description: Systematic review of built-in functions (scalar, aggregate, datetime, JSON, string)
dependencies: none
files:
  packages/quereus/src/func/context.ts
  packages/quereus/src/func/registration.ts
  packages/quereus/src/func/builtins/aggregate.ts
  packages/quereus/src/func/builtins/builtin-window-functions.ts
  packages/quereus/src/func/builtins/conversion.ts
  packages/quereus/src/func/builtins/datetime.ts
  packages/quereus/src/func/builtins/explain.ts
  packages/quereus/src/func/builtins/generation.ts
  packages/quereus/src/func/builtins/index.ts
  packages/quereus/src/func/builtins/json.ts
  packages/quereus/src/func/builtins/json-helpers.ts
  packages/quereus/src/func/builtins/json-tvf.ts
  packages/quereus/src/func/builtins/scalar.ts
  packages/quereus/src/func/builtins/schema.ts
  packages/quereus/src/func/builtins/string.ts
  packages/quereus/src/func/builtins/timespan.ts
----
Review built-in function implementations: scalar functions, aggregate functions, window functions, datetime, JSON, string, conversion, and generation functions.

Key areas of concern:
- NULL handling in all function implementations
- Type coercion correctness for function arguments
- Datetime edge cases (leap years, DST, epoch boundaries)
- JSON function correctness (nested paths, arrays, escaping)
- String function Unicode handling
- Aggregate function state management (reset, merge)
- Window function frame boundary correctness
- Function registration completeness and naming

Follow the review protocol in docs/review.md.
Trivial fixes may be applied directly; non-trivial findings become fix/ or plan/ tickets.
