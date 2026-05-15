---
description: Sargable range rewrite for `f(col) op c` predicates (initial: `=` over `date(datetime_col)`). Promotes monotone bucket conversions to half-open ranges on the base column so access-path selection can push them into Retrieve / index seeks.
prereq:
files:
  - packages/quereus/src/planner/rules/predicate/rule-sargable-range-rewrite.ts (new)
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/src/planner/analysis/predicate-conjuncts.ts
  - packages/quereus/src/planner/nodes/scalar.ts
  - packages/quereus/src/planner/nodes/function.ts
  - packages/quereus/src/func/builtins/conversion.ts
  - packages/quereus/src/types/temporal-types.ts
  - packages/quereus/src/types/logical-type.ts
  - packages/quereus/src/schema/function.ts
  - packages/quereus/test/optimizer/sargable-range-rewrite.spec.ts (new)
  - docs/optimizer.md
---

## Architecture

Consume the `ScalarPlanNode.rangeRewriteIn(attrId, constant)` surface that landed in `4-expression-properties-injective-monotone.md` to rewrite predicates of the form

```
f(col) = c    →    col >= lower(c)  AND  col < upper(c)
```

so that access-path selection (`rules/access/rule-select-access-path.ts`) — which pattern-matches against bare `col op literal` constraints in `analysis/constraint-extractor.ts:extractBinaryConstraint` — can push the resulting range into `RetrieveNode` and convert it to an `IndexSeekNode`.

### Pipeline placement

A new structural rule `rule-sargable-range-rewrite` registered against `PlanNodeType.Filter` at **Structural pass priority 18** — i.e. before `aggregate-predicate-pushdown` (19) and `predicate-pushdown` (20), so the rewritten conjuncts ride the same pushdown wave that already moves bare `col op lit` predicates into the Retrieve pipeline. Runs `phase: 'rewrite'`, no extra context required.

### Rule shape

```
ruleSargableRangeRewrite(filter):
  conjuncts := splitConjuncts(filter.predicate)
  changed := false
  out := []
  for each c in conjuncts:
    rewritten := tryRewriteEqualityToRange(c)
    if rewritten:
      out.push(rewritten); changed := true
    else:
      out.push(c)
  if not changed: return null
  return new FilterNode(filter.scope, filter.source, combineConjuncts(out))
```

### `tryRewriteEqualityToRange(expr)` — initial pattern

Only attempts the `=` form. The `<`, `<=`, `>`, `>=` shapes need direction analysis on `monotonicityIn` and asymmetric boundary handling — scoped out, captured in TODO § "Out of scope for this ticket".

Inputs accepted:

1. `expr` is a `BinaryOpNode` whose `expression.operator === '='`.
2. Exactly one operand is an `is-constant` literal (a `LiteralNode` after `unwrapCast`); the value is non-null. (Reuse the `unwrapCast` / `isLiteralConstant` helpers already in `analysis/constraint-extractor.ts`; export them or duplicate the small surface — preference: export a tiny `predicate-shape.ts` so we don't grow constraint-extractor's public surface beyond what it owes.)
3. The other operand is a "function-call-shaped" candidate that names a single dependent column attribute. Walk leaves of the candidate; require exactly one `ColumnReferenceNode` and that all other leaves are `LiteralNode` / `ParameterReferenceNode`. Take that `attributeId`.
4. Call `candidate.rangeRewriteIn(attrId, literalValue)`. If `undefined`, bail.
5. Build the rewritten predicate:

```
ColumnReferenceNode(attrId, ...) >= LiteralNode(lowerInclusive)
  AND
ColumnReferenceNode(attrId, ...) < LiteralNode(upperExclusive)
```

Both new `LiteralNode`s are typed with the column's logical type (carry through from `colRef.getType()`); the comparison nodes use the existing `BinaryOpNode` constructor with synthesized AST nodes (mirror the synth pattern already used in `rule-filter-merge.ts` and `core/database-assertions.ts`).

Reuse the existing `ColumnReferenceNode` instance (the same one we found inside the function-call subtree) so attribute-id identity is preserved verbatim — this matters for downstream constraint extraction and for `attributeId`-keyed maps in the optimizer.

### NULL semantics

- Constant value `null` → bail. The original `f(col) = null` already evaluates to null (rejects rows); a range with null bounds would be ill-defined.
- Column value `null` → the synthesized `col >= L AND col < U` evaluates to `null AND null = null`, which the WHERE / ON clauses treat as falsy — same row-rejection behavior as `f(null) = c`. No additional null-guarding required. Add a regression test that exercises a null column row to lock this in.
- The rewrite is a *replacement* of one conjunct, not an addition; it must not reintroduce the original `f(col) = c` term, since `f(date_col_null) = c` is null and the range conjuncts already preserve that.

### Type compatibility

`LogicalType.bucketBounds(kind, value)` returns `SqlValue`s in the **column's value space** (e.g. for a `DATETIME` column with `kind: 'date_bucket'`, returns ISO datetime strings, not date strings). Wrapping the bounds in `LiteralNode`s typed with the column's logical type keeps the constraint-extractor / vtab-side coercion happy: `extractBinaryConstraint` already accepts `col op literal` and the `IndexConstraint` machinery does not perform implicit conversions on the column side, so this avoids defeating sargability.

### Built-in trait wiring (initial)

To turn on a single useful case end-to-end, annotate `date(value)` (the single-arg conversion form in `func/builtins/conversion.ts`) and teach `DATETIME_TYPE.bucketBounds`:

- `func/builtins/conversion.ts`:
  ```ts
  export const DATE_FUNC = createScalarFunction(
    {
      name: 'date',
      numArgs: 1,
      deterministic: false,
      returnType: { ... },
      rangeRewriteOnArg: { 0: { kind: 'date_bucket' } },
    },
    ...
  );
  ```
  The variadic `dateFunc` in `func/builtins/datetime.ts` (numArgs: -1, modifiers) is intentionally **not** annotated — modifiers can shift / re-bucket arbitrarily. Verify dispatch resolution for `date(ts)` lands on the `numArgs: 1` variant before relying on the rewrite (call `Database.getFunction('date', 1)` style introspection in a sanity test); if the variadic shadows the unary in the registry, either reorder registration or have the rule additionally check `functionSchema.numArgs === 1` before consulting the trait.

- `types/temporal-types.ts`, `DATETIME_TYPE.bucketBounds`:
  - `kind: 'date_bucket'`, value is a date string parseable as `Temporal.PlainDate`:
    - lower = `${date}T00:00:00`
    - upper = the next day formatted as `${nextDate}T00:00:00`
    - Use `Temporal.PlainDate.from(value).add({ days: 1 })`.
  - Reject anything else (return `undefined`).

- `types/temporal-types.ts`, `DATE_TYPE.bucketBounds`:
  - `kind: 'date_bucket'`, value parseable as `PlainDate`:
    - lower = the date string itself
    - upper = next day as a date string
  - This makes `date(date_col) = D` rewrite to `date_col >= D AND date_col < D+1` — essentially still equality but carries through the same machinery; harmless and keeps trait wiring uniform.

- `LogicalType.bucketBounds` is already declared in `types/logical-type.ts` and the corresponding trait (`rangeRewriteOnArg`) is already on `FunctionSchema` — no surface changes; only implementations.

### Interaction with parameters (deferred)

The expression-properties surface takes a runtime `SqlValue` constant. For SQL-level `where date(ts) = :p`, the rule cannot fire at plan time because `:p` is not yet bound. The clean follow-up is parameter-aware rewriting (rewrite to `ts >= bucket_lower(:p) AND ts < bucket_upper(:p)` where `bucket_lower`/`bucket_upper` are scalar functions backed by the same `bucketBounds`). Out of scope here; capture in `tickets/backlog/` after this ticket lands.

### Tests

- `test/optimizer/sargable-range-rewrite.spec.ts`:
  - Unit-level (constructed `FilterNode` over a `date(ts)` projection):
    - `date(ts) = '2024-01-15'` rewrites to `ts >= '2024-01-15T00:00:00' AND ts < '2024-01-16T00:00:00'`.
    - Operand-flipped form `'2024-01-15' = date(ts)` also rewrites.
    - `date(ts) = null` is left alone (no rewrite).
    - Non-bucket function (`upper(name) = 'X'`) is left alone.
    - `f(g(ts)) = c` (function-call inside function-call) is left alone — covered by the identity-only check inside `rangeRewriteIn`.
    - Mixed conjuncts (one rewritable, one not) only rewrite the rewritable conjunct and preserve the rest.
  - SQL-level via `db.eval` + `query_plan(...)`:
    - Given `create table t(ts datetime, v int)` and a row with `ts = '2024-01-15T12:34:56'`, `select v from t where date(ts) = '2024-01-15'` returns the row, and the plan tree shows the predicate as a range on `ts` (assert via `query_plan` rendering the rewritten conjuncts on the Retrieve / Filter source).
    - Same query with a `'2024-01-16'` literal returns no rows (boundary-correctness).
    - Null row (`ts = null`) is excluded — same as before the rewrite.
  - Optional plan-shape test once a covering ordered structure exists: with a memory vtab whose primary key is `ts`, the plan should pick an `IndexSeekNode` for the range. If no current tess fixture demonstrates this cleanly, leave a failing-acceptance comment + TODO and rely on the generic `rangeBoundedOn` path (`rules/access/rule-monotonic-range-access.ts`).

### Documentation

Append to `docs/optimizer.md` § Engineering Considerations: a "Sargable range rewrites" subsection naming the rule, the trait/`bucketBounds` interplay, and the identity-only / `=`-only constraints. Cross-link from the existing "Scalar Expression Properties (per-attribute)" subsection.

## TODO

### Phase 1: Wiring + traits
- Add `rangeRewriteOnArg: { 0: { kind: 'date_bucket' } }` to the unary `DATE_FUNC` in `func/builtins/conversion.ts`. Confirm dispatch picks the unary form for `date(ts)` (`Database.getFunction('date', 1)`); if the variadic shadows it, gate the rule on `functionSchema.numArgs === 1`.
- Implement `DATETIME_TYPE.bucketBounds(kind='date_bucket', value)` and `DATE_TYPE.bucketBounds(kind='date_bucket', value)` in `types/temporal-types.ts`, using `Temporal.PlainDate.from(...).add({ days: 1 })` for the upper bound.

### Phase 2: Rewrite rule
- Add `packages/quereus/src/planner/rules/predicate/rule-sargable-range-rewrite.ts` with `ruleSargableRangeRewrite(node, ctx)`:
  - Accept only `FilterNode`.
  - `splitConjuncts`, `tryRewriteEqualityToRange` per the shape above.
  - Use existing `unwrapCast` / `isLiteralConstant` helpers (export from `constraint-extractor.ts` if currently file-local; otherwise inline the small predicate-shape helpers in a new `analysis/predicate-shape.ts`).
  - Synthesize `BinaryOpNode` AND-tree with reused `ColumnReferenceNode`s and freshly-constructed `LiteralNode`s typed with the column's logical type.
  - `combineConjuncts` (existing helper) to rebuild.
  - Return `null` when nothing changed.
- Register at `PassId.Structural`, priority 18, `phase: 'rewrite'` in `optimizer.ts:registerRulesToPasses`.

### Phase 3: Tests + docs
- Add `test/optimizer/sargable-range-rewrite.spec.ts` covering the cases above.
- Run `yarn workspace @quereus/quereus run test 2>&1 | tee /tmp/sargable-test.log` and verify no regressions in: `optimizer/expression-properties.spec.ts`, `planner/predicate-normalizer.spec.ts`, `planner/constraint-extractor.spec.ts`, `optimizer/keys-propagation.spec.ts`, the temporal-arithmetic tests.
- Update `docs/optimizer.md`.

### Out of scope for this ticket (capture as backlog after landing)
- `<`, `<=`, `>`, `>=` shapes (need direction analysis on `monotonicityIn` and asymmetric bound mapping).
- Parameter-aware rewrite (`date(ts) = :p` → bucket-bound scalar functions on `:p`).
- Additional bucket kinds (`datetime` normalization, `strftime` quanta, integer-bucketing functions).
- `decreasing` direction support in `rangeRewriteIn`.
