description: Add dedicated unit tests for emit/ast-stringify round-trip fidelity
dependencies: tickets/fix/4-emit-operator-precedence.md, tickets/fix/3-emit-missing-statement-types.md
files:
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/test/
----
The emit infrastructure (ast-stringify) currently has **no dedicated unit tests**. It is only exercised indirectly through sqllogic integration tests. This means:
- Operator precedence bugs go undetected
- Edge cases in quoting/escaping are untested
- New expression/statement types can be added without corresponding emit coverage

## Scope

Create a test file (e.g., `packages/quereus/test/emit.spec.ts`) that covers:

1. **Round-trip fidelity:** `parse(sql) → astToString → parse again` produces equivalent AST for:
   - All statement types (SELECT, INSERT, UPDATE, DELETE, CREATE TABLE, CREATE INDEX, CREATE VIEW, DROP, ALTER TABLE, etc.)
   - All expression types (literal, column, binary, unary, function, cast, case, subquery, exists, in, between, window, collate)

2. **Operator precedence:** Expressions with mixed precedence levels stringify with correct (and minimal) parenthesization:
   - `a + b * c` (no parens needed)
   - `(a + b) * c` (parens preserved)
   - `a = b < c` vs `(a = b) < c`
   - `a || b + c` vs `(a + b) || c`
   - `a or b and c` vs `(a or b) and c`

3. **Identifier quoting:** Keywords get quoted, normal identifiers don't, embedded quotes are escaped.

4. **String literal escaping:** Single quotes in string values are doubled.

5. **Edge cases:** Empty column lists, NULL literals, blob literals, bigint values, schema-qualified names.
