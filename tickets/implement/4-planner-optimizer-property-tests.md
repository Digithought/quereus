description: Property-based tests targeting planner and optimizer correctness invariants
dependencies: fast-check (already in devDependencies)
files:
  - packages/quereus/test/property-planner.spec.ts (new — all property tests)
  - packages/quereus/src/planner/optimizer-tuning.ts (add disabledRules field)
  - packages/quereus/src/planner/framework/pass.ts (skip disabled rules)
  - packages/quereus/src/planner/optimizer.ts (rule registry reference)
  - packages/quereus/src/core/database.ts (db.optimizer is public readonly)
----

## Goal

Add property-based tests (fast-check) that exercise planner/optimizer correctness invariants across randomly generated schemas, data, and queries.  The existing `test/property.spec.ts` covers parser, value, and comparison invariants — this new file targets the optimizer layer specifically.

## Infrastructure: selective rule disabling

To test semantic equivalence (rule-enabled vs rule-disabled), we need a way to skip individual optimizer rules at runtime.

**Change 1 — `OptimizerTuning` interface** (`src/planner/optimizer-tuning.ts`):

Add an optional field:

```typescript
/** Set of rule IDs to skip during optimization (test/debug use) */
readonly disabledRules?: ReadonlySet<string>;
```

No change to `DEFAULT_TUNING` (field is optional, defaults to `undefined`).

**Change 2 — `PassManager.applyPassRules`** (`src/planner/framework/pass.ts`, around line 378):

Before the existing `hasRuleBeenApplied` check, add:

```typescript
if (context.tuning.disabledRules?.has(rule.id)) continue;
```

This is the only code path that applies pass-scoped rules; the legacy `applyRules()` in `registry.ts` is only called from `Optimizer.optimizeNode()` which is not used by the pass-based pipeline — but add the same guard there for safety (line ~198):

```typescript
if (context.tuning.disabledRules?.has(rule.id)) continue;
```

**Access from tests**: `db.optimizer` is `public readonly` on `Database`, and `Optimizer.tuning` is `public` with `updateTuning(t)`.  Tests toggle rules via:

```typescript
const baseTuning = db.optimizer.tuning;
db.optimizer.updateTuning({ ...baseTuning, disabledRules: new Set(['predicate-pushdown']) });
// ... run query ...
db.optimizer.updateTuning(baseTuning); // restore
```

## Rewrite rules eligible for equivalence testing

These are the structural/rewrite rules whose disabling must not change query results:

| Rule ID | Pass | What it does |
|---------|------|--------------|
| `predicate-pushdown` | Structural | Pushes filters closer to data sources |
| `filter-merge` | Structural | Merges adjacent Filter nodes |
| `join-key-inference` | Structural | Infers equi-join keys from ON clause |
| `join-greedy-commute` | Structural | Swaps join inputs for cost |
| `distinct-elimination` | Structural | Removes DISTINCT when source has unique keys |
| `projection-pruning` | Structural | Removes unused inner projections |
| `scalar-cse` | Structural | Deduplicates common scalar expressions |
| `subquery-decorrelation` | Structural | Converts correlated EXISTS/IN to semi-joins |

Physical/impl rules (`select-access-path`, `aggregate-physical`, `join-physical-selection`, `quickpick-join-enumeration`) are **not** tested this way since disabling them may leave logical nodes that can't be executed.

## Test file: `test/property-planner.spec.ts`

### Shared arbitraries and helpers

**Column type arbitrary**: `fc.constantFrom('INTEGER', 'REAL', 'TEXT')` — skip BLOB for simpler comparison.

**Table schema arbitrary**:
```typescript
interface ColSpec { name: string; type: 'INTEGER' | 'REAL' | 'TEXT' }
interface TableSpec { name: string; columns: ColSpec[] }
```
- 1–3 tables, names `t1`, `t2`, `t3`
- Each table: first column always `id INTEGER PRIMARY KEY`, then 1–4 random columns (`a`, `b`, `c`, `d`) with random types
- Use `USING memory`

**Row data arbitrary**: Given a `TableSpec`, generate 0–30 rows.  Values by type:
- INTEGER: `fc.integer({ min: -100, max: 100 })`
- REAL: `fc.float({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true })`
- TEXT: `fc.constantFrom('alpha', 'beta', 'gamma', 'delta', '', null)` — small vocabulary for higher collision/join hit rate, includes null

**Setup helper**: `async setupSchema(db, specs, rows)` — creates tables, inserts data.

**Collect helper**: `async collectResultSet(db, sql)` — returns `Record<string, SqlValue>[]`, consumed into array.

**Compare helper**: `assertSameResultSet(a, b)` — sorts both arrays by JSON-serialized row and deep-equals.  Order-insensitive.

### Property 1: Semantic equivalence under optimizer rules

```
describe('Semantic equivalence under optimizer rules')
```

For each rewrite rule ID in the table above, generate:
- A single-table schema with 2–4 columns and 5–20 rows
- A query template appropriate to the rule:
  - `predicate-pushdown` / `filter-merge`: `SELECT <cols> FROM t1 WHERE <cond1> AND <cond2>`
  - `join-greedy-commute` / `join-key-inference`: two tables, `SELECT * FROM t1 JOIN t2 ON t1.id = t2.a`
  - `distinct-elimination`: `SELECT DISTINCT id FROM t1`
  - `projection-pruning`: `SELECT a FROM (SELECT a, b FROM t1) sub`
  - `scalar-cse`: `SELECT a + b, a + b + 1 FROM t1`
  - `subquery-decorrelation`: `SELECT * FROM t1 WHERE a IN (SELECT a FROM t2)`

Run with all rules enabled, then with the specific rule disabled, and assert identical result sets.  Use `{ numRuns: 30 }` per rule for CI speed.

### Property 2: Optimizer determinism (idempotency proxy)

Run the same query on the same data twice (fresh prepare each time).  Compare `query_plan()` output — must be identical.  This verifies the optimizer is deterministic.

```
fc.asyncProperty(schemaArb, dataArb, queryArb, async (schema, data, query) => {
  // setup schema+data once
  const plan1 = await collectPlan(db, query);
  const plan2 = await collectPlan(db, query);
  expect(plan1).to.deep.equal(plan2);
});
```

`collectPlan` helper: `SELECT op, node_type FROM query_plan(?) ORDER BY id`.

### Property 3: Join commutativity

Generate two tables with a join column.  Assert:
```sql
SELECT * FROM t1 JOIN t2 ON t1.ref = t2.id
-- vs
SELECT * FROM t2 JOIN t1 ON t2.id = t1.ref
```
Same result set (order-insensitive, match by column name not position).

### Property 4: Monotonicity of WHERE

Generate a table with data.  Pick a random column and a value from the data.  Assert:
```sql
SELECT count(*) FROM t1
-- >=
SELECT count(*) FROM t1 WHERE <col> = <val>
```
The filtered count must be <= the unfiltered count.

### Property 5: NULL algebra

These are simpler properties that don't need random schemas — just random values:

- `NULL = NULL` is not true: `SELECT null = null` → not `1`
- `NULL IN (1, 2, NULL)` → NULL (not true, not false)
- `COALESCE(NULL, v)` = `v` for any non-null `v`
- `IS NULL` / `IS NOT NULL` consistency: for any value `v`, exactly one of `v IS NULL`, `v IS NOT NULL` is true
- Aggregates skip NULLs: `SELECT count(col) FROM t` with NULLs < `count(*)`

### Property 6: Aggregate invariants

Generate a table with a numeric column (mix of values and NULLs):

- `count(*) >= count(col)` (since count(col) skips NULLs)
- When both non-NULL: `min(col) <= max(col)`
- Single-row table: `sum(col)` = the value
- `avg(col)` between `min(col)` and `max(col)` (when non-NULL results)

Use `{ numRuns: 50 }` for aggregate tests.

## Key tests and expected outputs

| Test | Key assertion |
|------|---------------|
| Rule equivalence (predicate-pushdown disabled) | Same result set as with rule enabled |
| Rule equivalence (filter-merge disabled) | Same result set |
| Rule equivalence (join-greedy-commute disabled) | Same result set |
| Determinism | `query_plan()` identical on repeated runs |
| Join commutativity | `A JOIN B` = `B JOIN A` (as sets) |
| WHERE monotonicity | `count(*)` >= `count(*) WHERE ...` |
| NULL = NULL | Result is 0 or NULL, never 1 |
| count(*) >= count(col) | Always holds |
| min <= max | When both non-NULL |

----

## TODO

### Phase 1: Infrastructure
- Add `disabledRules?: ReadonlySet<string>` to `OptimizerTuning` in `src/planner/optimizer-tuning.ts`
- Add `if (context.tuning.disabledRules?.has(rule.id)) continue;` guard in `PassManager.applyPassRules()` in `src/planner/framework/pass.ts` (line ~379)
- Add same guard in `applyRules()` in `src/planner/framework/registry.ts` (line ~198)

### Phase 2: Test file scaffolding
- Create `packages/quereus/test/property-planner.spec.ts`
- Implement shared arbitraries: column type, table schema, row data
- Implement helpers: `setupSchema`, `collectResultSet`, `assertSameResultSet`, `collectPlan`
- Verify scaffolding compiles and a trivial test passes

### Phase 3: Property tests
- Semantic equivalence under optimizer rules (one `it()` per rule, using the rule-disable mechanism)
- Optimizer determinism (same query → same plan)
- Join commutativity
- Monotonicity of WHERE
- NULL algebra invariants
- Aggregate invariants

### Phase 4: Validate
- Run full test suite (`yarn test`) — existing tests must still pass
- Run new property tests specifically — all green
- Check that disabling rules doesn't break physical plan generation (the query still runs, just with a less-optimized plan)
