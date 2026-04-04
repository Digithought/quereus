description: Grammar-guided SQL fuzzer using fast-check to generate valid SQL for deep parser/planner/runtime coverage
files:
  - packages/quereus/test/fuzz.spec.ts (new — the fuzzer test suite)
  - packages/quereus/test/property.spec.ts (existing property tests — reference for patterns)
  - packages/quereus/src/common/errors.ts (QuereusError — expected error type)
----

## What Was Built

A grammar-guided SQL fuzzer in `packages/quereus/test/fuzz.spec.ts` that generates syntactically valid SQL strings via `fc.letrec` and executes them against the full engine pipeline (lexer → parser → planner → optimizer → emitter → runtime).

### Architecture

**Phase 1 — Schema generation**: Each test property creates a fresh `Database` with 1–3 tables (`t1`/`t2`/`t3`), each having 2–5 typed columns (integer/real/text/blob/any) with optional constraints (PK, NOT NULL, UNIQUE). Tables are seeded with 0–20 rows of type-appropriate random data.

**Phase 2 — SQL arbitraries via `fc.letrec`**: A mutually recursive set of arbitraries generates SQL strings:
- **Expressions**: literals, column refs, binary ops (+/-/\*/\//%, comparisons, logical, ||), unary ops, function calls (scalar single/double-arg), CASE/WHEN, CAST, IN, BETWEEN
- **Selects**: SELECT [DISTINCT] with expressions, FROM (single table or JOINs), WHERE, GROUP BY, HAVING, ORDER BY, LIMIT/OFFSET
- **Compounds**: UNION [ALL] / INTERSECT / EXCEPT
- **CTEs**: WITH ... AS (select) select
- **Window functions**: row_number, rank, dense_rank, ntile, lag, lead, first_value, last_value with OVER + frame specs
- **DML**: INSERT with VALUES + optional RETURNING, UPDATE with SET/WHERE, DELETE with WHERE

Depth-bounded at 3 levels via `depthIdentifier` + `maxDepth` on recursive `oneof` calls.

**Phase 3 — No-crash invariant**: Every execution must either succeed or throw `QuereusError`. Any other exception type (TypeError, RangeError, etc.) is a test failure.

### Test Cases (5 property tests)

| Test | numRuns | Samples/run | What it tests |
|------|---------|-------------|---------------|
| SELECT queries do not crash | 200 | 5 | Full SELECT pipeline including expressions, JOINs, aggregation |
| DML queries do not crash | 100 | 3 | INSERT/UPDATE/DELETE with RETURNING |
| compound/CTE queries do not crash | 100 | 4 | UNION/INTERSECT/EXCEPT + WITH...AS CTEs |
| window function queries do not crash | 100 | 3 | All window functions with frame specs |
| mixed workload do not crash | 200 | 5 | Random mix of all statement types |

### Performance

Full suite runs in ~2 seconds (well within 60s CI target). 120s mocha timeout configured as safety margin.

### Testing / Validation

- All 5 fuzz tests pass clean
- Full test suite (1141 tests) passes
- Deterministic with a given seed (fast-check handles this)
- If the fuzzer finds a crash, that's a real bug — the error message includes the SQL that caused it

### Usage

```bash
# Run just the fuzzer
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/fuzz.spec.ts"

# Run with specific seed for reproduction
# (fast-check reports seed in failure output)
```
