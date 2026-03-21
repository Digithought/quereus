description: Fix operator precedence table in ast-stringify to match parser — incorrect grouping causes round-trip semantic changes
dependencies: none
files:
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/test/emit-precedence.spec.ts
----
## Summary

The `needsParens` precedence table in `ast-stringify.ts` did not match the parser's actual operator precedence hierarchy. This caused round-trip semantic changes (parse → stringify → parse could produce a different AST).

### Changes made

**`packages/quereus/src/emit/ast-stringify.ts`:**
- Updated precedence table to match the parser hierarchy:
  - Separated equality (`=`, `==`, `!=`) at level 3 from comparison (`<`, `<=`, `>`, `>=`, `LIKE`, `GLOB`, `MATCH`, `REGEXP`) at level 4
  - Added `||` (concatenation) at level 7 (highest binary precedence)
  - Added `XOR` at level 1 (same as `OR`)
  - Removed stale `NOT`, `IN`, `IS` entries (these have their own AST node types and never appear as binary operators)
- Updated `isAssociative()` to include `XOR` and `||`

### Test coverage

**`packages/quereus/test/emit-precedence.spec.ts`** — 14 round-trip tests:
- Equality vs comparison: `(a = b) < c` preserves parens; `a = (b < c)` drops unnecessary parens
- Concatenation `||`: `(a + b) || c` preserves parens; `a || b || c` no extra parens
- XOR: `(a xor b) and c` preserves parens
- Mixed precedence chains: full low→high and high→low chains round-trip correctly
- Right-associativity: `a - (b - c)` preserves parens; `a + (b + c)` drops them (associative)

### Validation
- All 927 existing tests pass
- TypeScript type check clean
