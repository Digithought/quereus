description: Stacked unary operators without parentheses fail to parse (e.g., `- -1`, `NOT NOT x`)
dependencies: none
files:
  packages/quereus/src/parser/parser.ts
----
In `factor()`, unary operators (`-`, `+`, `~`, `NOT`) call `this.concatenation()` for the operand instead of recursing through `factor()` or a dedicated `unary()` method. This means `- -1`, `NOT NOT x`, `~-x`, etc. fail with "Expected expression" at the second operator.

SQLite supports `SELECT - -1` (returns 1), so this is a compatibility gap.

The existing test `should parse double negation: -(-1)` uses parentheses to work around this.

### Fix approach
Extract a `unary()` method that handles unary prefix operators recursively, then have `factor()` delegate to it:

```typescript
private factor(): AST.Expression {
    return this.parseBinaryChain(
        () => this.unary(),
        [TokenType.ASTERISK, TokenType.SLASH, TokenType.PERCENT],
        (t) => t.lexeme,
    );
}

private unary(): AST.Expression {
    if (this.match(TokenType.MINUS, TokenType.PLUS, TokenType.TILDE, TokenType.NOT)) {
        const operatorToken = this.previous();
        const right = this.unary(); // recurse for stacked unary
        return { type: 'unary', operator: operatorToken.lexeme, expr: right, loc: _createLoc(operatorToken, this.previous()) };
    }
    return this.concatenation();
}
```

This ensures `- -x` parses as `-(-(x))` and `-a * b` still parses as `(-a) * b`.

### TODO
- Extract `unary()` from `factor()` as described
- Add test for `- -1` (no parens)
- Add test for `NOT NOT 1`
- Verify existing tests pass
