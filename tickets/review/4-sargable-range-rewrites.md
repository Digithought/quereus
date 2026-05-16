---
description: Sargable range rewrite for `f(col) op c` predicates. Initial coverage: `date(datetime_col) = D` rewrites to `datetime_col >= 'D T00:00:00' AND datetime_col < 'D+1 T00:00:00'`, so the bare-column range can be pushed into Retrieve and (when an ordered access path exists) seek-fed.
prereq:
files:
  - packages/quereus/src/planner/rules/predicate/rule-sargable-range-rewrite.ts (new)
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/src/func/builtins/conversion.ts
  - packages/quereus/src/func/registration.ts
  - packages/quereus/src/types/temporal-types.ts
  - packages/quereus/test/optimizer/sargable-range-rewrite.spec.ts (new)
  - docs/optimizer.md
---

## What was built

### Rule

`packages/quereus/src/planner/rules/predicate/rule-sargable-range-rewrite.ts` (new). For each conjunct of a `FilterNode`'s predicate:

```
f(col) = c    →    col >= lower(c)  AND  col < upper(c)
```

- Recognizes `BinaryOpNode { operator: '=' }` with exactly one literal side (CAST-unwrapped) and a candidate side that bottoms out at exactly one `ColumnReferenceNode` (other leaves may be literals / parameters).
- Calls `candidate.rangeRewriteIn(attrId, literalValue)`. That surface, defined on `PlanNode` and overridden on `ScalarFunctionCallNode` (already shipping from prereq ticket `4-expression-properties-injective-monotone`), consults `FunctionSchema.rangeRewriteOnArg` and delegates the boundary math to `LogicalType.bucketBounds(kind, value)`.
- Reuses the **same `ColumnReferenceNode`** instance on both sides of the rewritten AND-tree so `attributeId` identity is preserved verbatim — `analysis/constraint-extractor.extractBinaryConstraint` reads off it directly.
- Literals are wrapped in `LiteralNode`s typed with the column's `ScalarType` so `extractBinaryConstraint`'s constant-side path doesn't trip on type-coercion.
- Null constant → returns `null` (no rewrite — `f(col) = null` is already null/false-rejecting; range with null bounds would be meaningless).
- Mixed conjuncts: only the rewritable conjuncts change; everything else passes through unchanged.

Registered at `PassId.Structural`, **priority 18**, `phase: 'rewrite'` — before `aggregate-predicate-pushdown` (19) and `predicate-pushdown` (20), so the rewritten conjuncts ride the same pushdown wave the bare-`col op literal` shape already gets.

### Trait wiring

- `func/builtins/conversion.ts` — unary `DATE_FUNC` (`numArgs: 1`) annotated with `rangeRewriteOnArg: { 0: { kind: 'date_bucket' } }`. The variadic `dateFunc` in `func/builtins/datetime.ts` (`numArgs: -1`, modifiers) is intentionally **not** annotated — modifiers can shift/re-bucket. Dispatch in `schema-resolution.ts:resolveFunctionSchema` tries exact-arg-count first, so `date(ts)` lands on the unary form; the rule itself further guards with the identity-only check inside `rangeRewriteIn`, so even if the variadic shadowed the unary the result would be `undefined` (because variadic doesn't carry the trait).
- `func/registration.ts:createScalarFunction` now passes through `injectiveOnArgs` / `monotoneOnArgs` / `rangeRewriteOnArg` from the options bag to the returned schema. (Previously these were only set via direct object-literal construction in the test helper; production paths had no way to attach them.)

### `bucketBounds` implementations

- `DATE_TYPE.bucketBounds('date_bucket', value)` → `{ lower: value, upper: nextDay }` (both date strings).
- `DATETIME_TYPE.bucketBounds('date_bucket', value)` → `{ lower: 'YYYY-MM-DDT00:00:00', upper: 'YYYY-MM-DD+1T00:00:00' }` (ISO datetime strings, midnight UTC). The lower-bound formatter parses `value` as a `Temporal.PlainDate`, then both bounds are built from `PlainDate.add({ days: 1 })` so DST / month-end corner cases are correct.
- Both reject unrecognized kinds and non-string values by returning `undefined`.

### Docs

`docs/optimizer.md` § Engineering Considerations: new "Sargable range rewrites" subsection with rule wiring, identity-only / `=`-only constraints, and a parameter-aware-rewrite follow-up note. Cross-linked from the existing "Scalar Expression Properties (per-attribute)" subsection.

## Use cases / behaviors

Manual verification via `db.eval(...)` over a memory vtab:

```
create table t (id INTEGER PRIMARY KEY, ts DATETIME NULL, v INTEGER) USING memory;
insert into t values (1, '2024-01-15T12:34:56', 10),
                     (2, '2024-01-16T00:00:00', 20),
                     (3, '2024-01-14T23:59:59',  5),
                     (4, null, 99);
select v from t where date(ts) = '2024-01-15';   -- → 10
select v from t where date(ts) = '2024-01-16';   -- → 20  (boundary excluded from previous bucket)
select v from t where date(ts) = '2024-01-14';   -- →  5
-- null-ts row never matches (consistent with f(null) = c).
```

`query_plan(...)` for the first query renders the Filter predicate as `ts >= '2024-01-15T00:00:00' and ts < '2024-01-16T00:00:00'` — no `date(ts)` call survives in the rewritten conjunct, confirming the constraint extractor will see a `col op literal` shape.

## Test plan / floor

`packages/quereus/test/optimizer/sargable-range-rewrite.spec.ts` (new): 10 cases.

Unit (against a hand-constructed `FilterNode` over a stub relation):

- `date(ts) = '2024-01-15'` rewrites to two conjuncts with operators `>=` and `<`; both reuse the original `ColumnReferenceNode` instance; literal values are `'2024-01-15T00:00:00'` and `'2024-01-16T00:00:00'`.
- `'2024-01-15' = date(ts)` (flipped form) also rewrites.
- `date(ts) = null` returns `null` (no rewrite).
- `upper(name) = 'X'` (non-bucket fn) returns `null`.
- `date(inner(ts)) = D` returns `null` (operand not bare column reference — identity-only check enforced inside `rangeRewriteIn`).
- Mixed conjuncts: `date(ts) = D AND name = 'Alpha'` rewrites only the bucket conjunct.

SQL (via `db.eval` against a memory vtab):

- `date(ts) = D` returns the in-bucket row.
- `D+1` returns the next bucket's row, not the previous bucket's (boundary correctness).
- Null-ts row excluded.
- `query_plan(...)` exposes `ts >= 'D T00:00:00'` and `ts < 'D+1 T00:00:00'` in the Filter predicate.

**Known floor / gaps** — the reviewer should treat these as starting-point limits, not finish lines:

- **No plan-shape assertion that the rewrite enables `IndexSeek`.** The rewritten range is a bare `col op literal` shape and rides through `predicate-pushdown` into Retrieve, so `rule-select-access-path` and `rule-monotonic-range-access` should be able to consume it. I did not add a fixture that demonstrates IndexSeek selection end-to-end — the memory vtab does not currently expose a covering ordered index on `DATETIME` that the existing test helpers spin up. The query_plan test asserts the rewritten predicate is visible (which is the precondition); turning it into an IndexSeek-asserting test depends on a fixture with a `(ts)` index over a memory vtab and is worth verifying in review.
- **Single `kind` covered.** Only `'date_bucket'` on `DATE_TYPE` / `DATETIME_TYPE`. The trait machinery is generic; additional kinds (`strftime` quanta, integer bucketing) are out of scope for this ticket and called out for backlog promotion below.
- **Single operator (`=`) covered.** The `<`/`<=`/`>`/`>=` shapes need direction analysis on `monotonicityIn` (for `decreasing`-monotone fns the bound mapping flips) and asymmetric inclusivity. Backlogged.
- **No parameter-bound RHS** (`where date(ts) = :p`). Same surface, but the rule needs a literal at plan time. A follow-up should introduce scalar `bucket_lower(:p)` / `bucket_upper(:p)` functions backed by the same `bucketBounds`. Backlogged.

## Validation

- `yarn workspace @quereus/quereus run build` — clean (exit 0).
- `yarn workspace @quereus/quereus run lint` — clean (exit 0).
- `yarn workspace @quereus/quereus run test` (memory vtab) — **3167 passing, 0 failing**. No regressions in the test files the ticket flagged as risk-sensitive (`optimizer/expression-properties.spec.ts`, `planner/predicate-normalizer.spec.ts`, `planner/constraint-extractor.spec.ts`, `optimizer/keys-propagation.spec.ts`, temporal-arithmetic tests — all green).
- `yarn test:store` and `yarn test:full` were not run — store-specific behavior is unaffected (the rule only touches the predicate tree, not access path execution).

## Follow-ups to promote to backlog

- `<`, `<=`, `>`, `>=` shapes — direction analysis on `monotonicityIn`, asymmetric bound mapping.
- Parameter-aware rewrite — `date(ts) = :p` via `bucket_lower(:p)` / `bucket_upper(:p)` scalar functions.
- Additional bucket kinds — `datetime` normalization, `strftime` quanta, integer-bucketing functions.
- `decreasing`-direction support in `rangeRewriteIn`.
- End-to-end IndexSeek plan-shape test once a covering `(ts)`-ordered fixture is available.
