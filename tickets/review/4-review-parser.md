description: Systematic review of the SQL parser (lexer, parser, AST, visitor)
dependencies: none
files:
  packages/quereus/src/parser/ast.ts
  packages/quereus/src/parser/index.ts
  packages/quereus/src/parser/lexer.ts
  packages/quereus/src/parser/parser.ts
  packages/quereus/src/parser/utils.ts
  packages/quereus/src/parser/visitor.ts
----
Review the SQL parser: lexer tokenization, recursive-descent parser, AST node definitions, and visitor pattern.

Key areas of concern:
- Parser correctness for edge-case SQL syntax
- Lexer handling of string escapes, numeric literals, identifiers
- AST completeness (all SQL constructs represented)
- Error recovery and error message quality
- Visitor pattern completeness (all node types visited)
- Performance of parsing (unnecessary allocations, backtracking)

Follow the review protocol in docs/review.md.
Trivial fixes may be applied directly; non-trivial findings become fix/ or plan/ tickets.
