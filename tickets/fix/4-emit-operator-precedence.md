description: Fix operator precedence table in ast-stringify to match parser — incorrect grouping causes round-trip semantic changes
dependencies: none
files:
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/src/parser/parser.ts
----
The `needsParens` precedence table in `ast-stringify.ts` does not match the parser's actual operator precedence hierarchy. This can cause round-trip semantic changes (parse → stringify → parse produces different AST).

## Current table (lines 270-273)
```
OR: 1, AND: 2, NOT: 3, =: 4, !=: 4, <: 4, <=: 4, >: 4, >=: 4,
LIKE: 4, IN: 4, IS: 4, +: 5, -: 5, *: 6, /: 6, %: 6
```

## Parser precedence (low → high)
```
OR, XOR → AND → IS NULL → =, != → <, <=, >, >=, LIKE → +, - → *, /, % → ||
```

## Defects

1. **Equality and comparison at same level:** `=`/`!=` and `<`/`<=`/`>`/`>=`/`LIKE` are all at level 4, but the parser separates them (equality lower than comparison). Result: `(a = b) < c` loses parens on stringify, re-parses as `a = (b < c)`.

2. **Missing `||` (concatenation):** Has the highest binary precedence in the parser but is absent from the table (defaults to 0 = lowest). Result: `(a + b) || c` loses parens, re-parses as `a + (b || c)`.

3. **Missing `XOR`:** Parsed at same level as OR but absent from table.

4. **`NOT` in binary table:** NOT is a unary prefix operator, not a binary operator. It doesn't belong in this table and will never match (unary NOT has its own AST type). Harmless but misleading.

5. **`IN` and `IS` entries:** These have their own AST node types (`in`, unary `IS NULL`), so they never appear as binary operators. Harmless but should be removed for clarity.

## Corrected table
```typescript
const precedence: Record<string, number> = {
    'OR': 1, 'XOR': 1,
    'AND': 2,
    '=': 3, '==': 3, '!=': 3,
    '<': 4, '<=': 4, '>': 4, '>=': 4, 'LIKE': 4, 'GLOB': 4, 'MATCH': 4, 'REGEXP': 4,
    '+': 5, '-': 5,
    '*': 6, '/': 6, '%': 6,
    '||': 7,
};
```

Also add `'||'` to `isAssociative()` and `'XOR'` if XOR is considered associative.

## TODO
- Update the precedence table to match the parser
- Update `isAssociative` accordingly
- Remove stale `NOT`, `IN`, `IS` entries
- Add round-trip tests covering the edge cases above
