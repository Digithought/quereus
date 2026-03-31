description: Add comprehensive emit/ast-stringify round-trip unit tests
dependencies: none (predecessor fix tickets are complete)
files:
  packages/quereus/test/emit-roundtrip.spec.ts (new — main deliverable)
  packages/quereus/src/emit/ast-stringify.ts (reference only)
  packages/quereus/src/emit/index.ts (imports: astToString, expressionToString, quoteIdentifier)
  packages/quereus/src/parser/index.ts (imports: parse, parseAll)
  packages/quereus/test/emit-precedence.spec.ts (existing — do not duplicate)
  packages/quereus/test/emit-missing-types.spec.ts (existing — do not duplicate)
----

## Context

The emit infrastructure has some test coverage from prior fix tickets:
- `emit-precedence.spec.ts` — 24 operator precedence round-trip tests (binary expressions)
- `emit-missing-types.spec.ts` — 11 tests for alterTable, analyze, createAssertion, mutatingSubquerySource (AST-constructed, not parse-based round-trip)

What's still missing is systematic parse→stringify→parse round-trip coverage across all statement and expression types, plus direct tests for identifier quoting and string escaping.

## Implementation

Create `packages/quereus/test/emit-roundtrip.spec.ts` using Mocha + Chai (matching existing test conventions).

### Test Helpers

```typescript
import { expect } from 'chai';
import { parse, parseAll } from '../src/parser/index.js';
import { astToString, expressionToString, quoteIdentifier } from '../src/emit/index.js';
import type { SelectStmt, Expression } from '../src/parser/index.js';

/** Round-trip a full statement: parse → stringify → parse → stringify, compare strings */
function roundTripStmt(sql: string): string {
    const ast1 = parse(sql);
    const str1 = astToString(ast1);
    const ast2 = parse(str1);
    const str2 = astToString(ast2);
    expect(str2, `statement round-trip mismatch for: ${sql}`).to.equal(str1);
    return str1;
}

/** Round-trip an expression via SELECT wrapper */
function roundTripExpr(exprSql: string): string {
    const stmt = parse(`select ${exprSql}`) as SelectStmt;
    const col = stmt.columns[0];
    if (col.type !== 'column') throw new Error('Expected column result');
    const str1 = expressionToString(col.expr);
    const stmt2 = parse(`select ${str1}`) as SelectStmt;
    const col2 = stmt2.columns[0];
    if (col2.type !== 'column') throw new Error('Expected column result');
    const str2 = expressionToString(col2.expr);
    expect(str2, `expression round-trip mismatch for: ${exprSql}`).to.equal(str1);
    return str1;
}
```

### Test Sections

#### 1. Statement round-trips (`describe('Emit: statement round-trips')`)

Test each statement type parses and round-trips cleanly. One `it()` per variant:

- **SELECT**: basic columns, WHERE, ORDER BY, LIMIT/OFFSET, GROUP BY/HAVING, DISTINCT, compound (UNION/UNION ALL/INTERSECT/EXCEPT), subquery in FROM, JOIN variants (inner, left, right, cross), WITH CTE, WITH RECURSIVE
- **INSERT**: INSERT INTO ... VALUES, INSERT INTO ... SELECT, INSERT with column list, INSERT OR REPLACE, INSERT with ON CONFLICT / upsert, INSERT with RETURNING
- **UPDATE**: basic SET, with WHERE, with FROM, UPDATE OR IGNORE, with RETURNING
- **DELETE**: basic, with WHERE, with RETURNING
- **VALUES**: standalone VALUES clause
- **CREATE TABLE**: columns with types, constraints (PRIMARY KEY, NOT NULL, UNIQUE, DEFAULT, CHECK, FOREIGN KEY, GENERATED), IF NOT EXISTS, table constraints
- **CREATE INDEX**: basic, UNIQUE, IF NOT EXISTS, WHERE (partial index)
- **CREATE VIEW**: basic, IF NOT EXISTS, with column list
- **DROP**: DROP TABLE, DROP INDEX, DROP VIEW, IF EXISTS
- **ALTER TABLE**: RENAME TO, RENAME COLUMN, ADD COLUMN, DROP COLUMN
- **Transaction**: BEGIN, BEGIN DEFERRED/IMMEDIATE/EXCLUSIVE, COMMIT, ROLLBACK, ROLLBACK TO, SAVEPOINT, RELEASE
- **PRAGMA**: bare pragma, pragma = value, pragma(value)
- **ANALYZE**: bare, with table name

#### 2. Expression round-trips (`describe('Emit: expression round-trips')`)

Do NOT duplicate what emit-precedence.spec.ts already covers (binary operator precedence). Focus on expression types:

- **Literals**: integer, float, negative number, string, NULL, TRUE/FALSE (if supported), blob literal (x'ABCD')
- **Column references**: simple column, table.column, schema.table.column
- **Unary**: NOT expr, -expr, +expr, expr IS NULL, expr IS NOT NULL
- **Function calls**: simple (length(x)), multi-arg (substr(x, 1, 3)), count(*), count(distinct x), aggregate with no args
- **CAST**: cast(x as integer), cast(x as text)
- **CASE**: simple CASE x WHEN ... , searched CASE WHEN ... , with ELSE
- **Subquery expression**: (select 1)
- **EXISTS**: exists (select 1 from t)
- **IN**: x in (1,2,3), x in (select id from t)
- **BETWEEN**: x between 1 and 10, x not between 1 and 10
- **COLLATE**: x collate nocase
- **Window functions**: row_number() over (order by x), sum(x) over (partition by y order by z), with frame spec (rows between unbounded preceding and current row)
- **Nested/compound**: function(a + b * c), CASE WHEN x IN (1,2) THEN 'a' ELSE 'b' END

#### 3. Identifier quoting (`describe('Emit: identifier quoting')`)

Test `quoteIdentifier()` directly:

- Normal identifier: `users` → `users` (no quoting)
- Reserved keyword: `select` → `"select"`, `from` → `"from"`, `table` → `"table"`
- Identifier with spaces or special chars: `my table` → `"my table"`
- Identifier starting with digit: `1abc` → `"1abc"`
- Embedded double quotes: `a"b` → `"a""b"`
- Underscore-prefixed: `_private` → `_private` (no quoting needed)

#### 4. String literal escaping (`describe('Emit: string literal escaping')`)

Test via expression round-trip:

- Simple string: `'hello'`
- String with embedded single quote: `'it''s'`
- Empty string: `''`
- String with multiple quotes: `'a''b''c'`

#### 5. Edge cases (`describe('Emit: edge cases')`)

- NULL literal round-trip
- Aliased expressions: `select 1 as x`
- Star expression: `select *`
- Table.star: `select t.*`
- Schema-qualified table in FROM: `select * from schema1.t`
- Multiple statements via parseAll (verify each round-trips)

### What NOT to test (already covered)

- Operator precedence parenthesization — covered in `emit-precedence.spec.ts`
- AlterTable/Analyze/CreateAssertion AST construction — covered in `emit-missing-types.spec.ts`
- Error handling for malformed AST — covered in `emit-create-assertion.spec.ts`

## TODO

- Create `packages/quereus/test/emit-roundtrip.spec.ts` with all sections above
- Verify all tests pass with `yarn test` (or at minimum `npx mocha` on the new file)
- If any round-trip fails, determine if it's a test issue or an emitter bug; file a separate fix ticket for emitter bugs if found
