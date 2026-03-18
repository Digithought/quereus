description: Systematic review of emit infrastructure (AST stringification)
dependencies: none
files:
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/src/emit/index.ts
----
Review the top-level emit infrastructure: AST-to-SQL stringification.

Key areas of concern:
- SQL output correctness for all AST node types
- Proper quoting/escaping of identifiers and string literals
- Operator precedence in generated SQL (unnecessary vs missing parentheses)
- Completeness (all AST node types handled, no silent fallthrough)
- Round-trip fidelity (parse → stringify → parse produces same AST)

Follow the review protocol in docs/review.md.
Trivial fixes may be applied directly; non-trivial findings become fix/ or plan/ tickets.
