description: Systematic review of runtime emitters for expressions and scalar operations
dependencies: none
files:
  packages/quereus/src/runtime/emit/binary.ts
  packages/quereus/src/runtime/emit/unary.ts
  packages/quereus/src/runtime/emit/cast.ts
  packages/quereus/src/runtime/emit/case.ts
  packages/quereus/src/runtime/emit/between.ts
  packages/quereus/src/runtime/emit/collate.ts
  packages/quereus/src/runtime/emit/parameter.ts
  packages/quereus/src/runtime/emit/scalar-function.ts
  packages/quereus/src/runtime/emit/temporal-arithmetic.ts
----
Review runtime emitters for expressions: binary operators, unary operators, CAST, CASE/WHEN, BETWEEN, COLLATE, parameters, scalar function calls, and temporal arithmetic.

Key areas of concern:
- Binary operator null propagation (AND/OR three-valued logic vs arithmetic null)
- Division by zero handling
- Integer overflow behavior
- CAST — all type pair conversions, lossy conversion handling
- CASE — short-circuit evaluation, null matching in CASE x WHEN null
- BETWEEN — inclusive boundaries, type coercion of operands
- Collation — correct comparison semantics
- Parameter binding — type coercion, missing parameter handling
- Temporal arithmetic — interval addition/subtraction edge cases (month overflow, DST)

Follow the review protocol in docs/review.md.
Trivial fixes may be applied directly; non-trivial findings become fix/ or plan/ tickets.
