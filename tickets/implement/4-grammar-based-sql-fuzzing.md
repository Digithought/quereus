description: Grammar-guided SQL fuzzer using fast-check to generate valid SQL for deep parser/planner/runtime coverage
dependencies: fast-check ^4.5.3 (already in devDependencies)
files:
  - packages/quereus/test/fuzz.spec.ts (new — the fuzzer test suite)
  - packages/quereus/test/property.spec.ts (existing property tests — reference for patterns)
  - packages/quereus/src/parser/ast.ts (AST type definitions — reference for SQL structures)
  - packages/quereus/src/core/database.ts (Database class — exec/eval/get)
  - packages/quereus/src/common/errors.ts (QuereusError — expected error type)
----

## Overview

Build a grammar-guided SQL fuzzer as a new test file `packages/quereus/test/fuzz.spec.ts` using fast-check's `letrec` to generate syntactically valid SQL strings and execute them against the engine.  The goal is to push past the parser error-recovery paths (already covered by `property.spec.ts` "Parser Robustness" suite) into the planner, optimizer, and runtime.

## Architecture

The fuzzer generates **SQL strings** (not AST objects), so the full pipeline is exercised: lexer → parser → planner → optimizer → emitter → runtime.

### Phase 1: Schema Generation

Generate a small schema (1–3 tables) with:
- Table names from a pool: `t1`, `t2`, `t3`
- 2–5 columns per table
- Column types drawn from: `integer`, `real`, `text`, `blob`, `any`
- Constraints: optional `primary key` (at most one per table), `not null`, `unique`, `default <literal>`
- Run `CREATE TABLE` + seed each table with 0–20 rows of type-appropriate random data via `INSERT`

Keep the schema as a typed object so query generators can reference valid table/column names.

### Phase 2: SQL Arbitraries with `fc.letrec`

Use `fc.letrec` to define mutually recursive arbitraries.  All arbitraries produce **SQL strings**.

```
letrec(tie => ({
  expr:        oneof(tie('literal'), tie('column'), tie('binExpr'), tie('unaryExpr'),
                     tie('funcCall'), tie('caseExpr'), tie('castExpr'),
                     tie('subquery'), tie('inExpr'), tie('existsExpr'), tie('betweenExpr')),
  literal:     oneof(integer, real, string, null, boolean),
  column:      pick from schema's column names (optionally table-qualified),
  binExpr:     map([tie('expr'), operator, tie('expr')], ...),  // depth-bounded
  unaryExpr:   map([unaryOp, tie('expr')], ...),
  funcCall:    oneof(scalar funcs, aggregate funcs),
  caseExpr:    CASE WHEN ... THEN ... END,
  castExpr:    CAST(expr AS type),
  subquery:    ( tie('select') ),
  inExpr:      expr IN (values | subquery),
  existsExpr:  EXISTS ( tie('select') ),
  betweenExpr: expr BETWEEN expr AND expr,

  selectCore:  SELECT [DISTINCT] columns FROM tables [WHERE] [GROUP BY [HAVING]] [ORDER BY] [LIMIT],
  select:      selectCore [compound],
  compound:    UNION [ALL] | INTERSECT | EXCEPT with another selectCore,
  join:        table joinType table ON condition,
  cte:         WITH name AS ( select ),
  window:      func OVER (PARTITION BY ... ORDER BY ... frame),

  insert:      INSERT INTO table (cols) VALUES (...) [RETURNING],
  update:      UPDATE table SET col=expr [WHERE] [RETURNING],
  delete:      DELETE FROM table [WHERE] [RETURNING],
  createTable: CREATE TABLE ... (for additional dynamic schema),
}))
```

**Depth bounding**: Use fast-check's `depthIdentifier` option on `oneof`/`letrec` to cap recursion at 3–4 levels.  Alternatively, thread a depth counter through `fc.memo` or use `withMaxDepth` on the letrec tie.

**Operators**:
- Arithmetic: `+`, `-`, `*`, `/`, `%`
- Comparison: `=`, `!=`, `<`, `<=`, `>`, `>=`, `is`, `is not`
- Logical: `and`, `or`
- String: `||`, `like`, `glob`

**Built-in functions** (safe subset):
- Scalar: `abs`, `coalesce`, `ifnull`, `nullif`, `typeof`, `length`, `upper`, `lower`, `trim`, `substr`, `replace`, `hex`, `quote`, `cast`, `iif`, `min`, `max`, `instr`, `unicode`, `char`
- Aggregate: `count`, `sum`, `avg`, `min`, `max`, `group_concat`, `total`
- Window-capable: `row_number`, `rank`, `dense_rank`, `ntile`, `lag`, `lead`, `first_value`, `last_value`

### Phase 3: Test Harness

```typescript
describe('Grammar-Based SQL Fuzzing', () => {
  // For each property run:
  // 1. Create fresh Database
  // 2. Create schema (from generated schema arbitrary)
  // 3. Seed tables with data
  // 4. Execute generated SQL
  // 5. Assert: either succeeds or throws QuereusError — never unhandled exception

  it('SELECT queries do not crash', ...)       // 200 runs
  it('DML queries do not crash', ...)           // 100 runs
  it('Compound/CTE queries do not crash', ...)  // 100 runs
  it('Window function queries do not crash', ...)// 100 runs
  it('Mixed workload does not crash', ...)      // 200 runs — random mix of all statement types
});
```

**No-crash invariant**: The test catches the result of execution. If it throws, it must be `instanceof QuereusError`.  Any other exception type (TypeError, RangeError, etc.) is a test failure.

```typescript
try {
  for await (const _row of db.eval(sql)) { /* drain */ }
} catch (err) {
  if (!(err instanceof QuereusError)) {
    throw new Error(`Unexpected ${err?.constructor?.name}: ${err?.message}\nSQL: ${sql}`);
  }
  // QuereusError is fine — the engine correctly rejected the query
}
```

### Bounds & Performance

| Parameter        | Value  | Rationale                           |
|------------------|--------|-------------------------------------|
| Expression depth | 3–4    | Keeps individual cases fast         |
| Row count/table  | 0–20   | Enough for joins, not slow          |
| Table count      | 1–3    | Keeps schema manageable             |
| Columns/table    | 2–5    | Enough variety for JOINs/GROUP BY   |
| Subquery depth   | 2      | Nested subqueries without explosion |
| Test timeout     | 120s   | Grammar tests are heavier           |

### Key Implementation Notes

- **Imports follow existing patterns**: `import { Database } from '../src/core/database.js'`, `import { QuereusError } from '../src/common/errors.js'`, `import * as fc from 'fast-check'`
- **Use lowercase SQL** per project convention
- **String quoting**: single-quote string literals, double-quote identifiers only when needed
- **Table/column names**: use simple unquoted identifiers (`t1`, `t2`, `c_int`, `c_text`, etc.) to avoid quoting complexities
- **`fc.letrec` depth control**: pass `{ depthIdentifier: 'expr' }` to recursive `oneof` calls, and set `maxDepth` in letrec options (fast-check v4 supports `depthIdentifier` + `maxDepth` on `oneof`)
- **Resource cleanup**: `await db.close()` in afterEach
- **Reproducibility**: Log the `fc` seed on failure.  fast-check does this automatically in its reporter, but also print the generated SQL in the error message so failures are easy to reproduce manually
- **Mocha timeout**: Set `this.timeout(120_000)` on the describe block

### Test Expectations (for review phase)

- The suite should find 0 crashes in a clean run (all QuereusError for invalid combos)
- If it does find a crash, that's a real bug to fix — the fuzzer is doing its job
- The suite should run in under 60s on CI (tune `numRuns` if needed)
- It should be deterministic with a given seed

## TODO

### Phase 1: Schema + data generators
- [ ] Define `SchemaInfo` type: `{ tables: TableInfo[] }` where `TableInfo = { name: string, columns: { name: string, type: string, primaryKey?: boolean, notNull?: boolean }[] }`
- [ ] Build `arbSchemaInfo`: generates 1–3 tables with 2–5 typed columns, at most one PK per table
- [ ] Build `arbSeedRow(table: TableInfo)`: generates a row of type-appropriate values
- [ ] Build helper `createSchema(db: Database, schema: SchemaInfo)`: runs CREATE TABLE + INSERT for seed data

### Phase 2: SQL string arbitraries
- [ ] Build `fc.letrec` structure producing SQL expression strings (literals, columns, binary/unary ops, function calls, CASE, CAST, subqueries, IN, EXISTS, BETWEEN) — depth-bounded
- [ ] Build `arbSelect(schema)`: SELECT with expressions, aliases, WHERE, GROUP BY, HAVING, ORDER BY, LIMIT, DISTINCT
- [ ] Build `arbJoin(schema)`: JOINs (inner, left, right, cross) with ON conditions
- [ ] Build `arbCompound(schema)`: set operations (UNION, INTERSECT, EXCEPT)
- [ ] Build `arbCte(schema)`: WITH ... AS (select) select
- [ ] Build `arbWindow(schema)`: window functions with frame specs (rows/range, bounded/unbounded)
- [ ] Build `arbInsert(schema)`: INSERT with VALUES and optional RETURNING
- [ ] Build `arbUpdate(schema)`: UPDATE with SET, WHERE, optional RETURNING
- [ ] Build `arbDelete(schema)`: DELETE with WHERE, optional RETURNING
- [ ] Build `arbCreateTable()`: CREATE TABLE with column types and constraints
- [ ] Build `arbStatement(schema)`: oneof all statement types

### Phase 3: Test suite
- [ ] Write describe block with beforeEach/afterEach for Database lifecycle
- [ ] Write "SELECT queries do not crash" property test (~200 runs)
- [ ] Write "DML queries do not crash" property test (~100 runs)
- [ ] Write "compound/CTE queries do not crash" property test (~100 runs)
- [ ] Write "window function queries do not crash" property test (~100 runs)
- [ ] Write "mixed workload does not crash" property test (~200 runs)
- [ ] Verify tests pass and run within time budget
- [ ] Tune numRuns/depth if any tests are too slow
