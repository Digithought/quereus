description: Pin `typeof()`'s return type to TEXT so the comparison emitter doesn't insert an implicit cast on the right-hand literal that then constant-folds to 0 and breaks CHECK predicates like `typeof(x) = 'integer'`.
files:
  packages/quereus/src/func/builtins/scalar.ts (typeofFunc registration, lines 159-180)
  packages/quereus/test/logic/40.2-check-extras.sqllogic (typeof CHECK fixture — was passing in mocha+ts-node by accident, now passes for the right reason)
----

## What was built

Added an explicit `returnType: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }` to the `typeof` registration in `scalar.ts`. Previously it relied on `createScalarFunction`'s default return type (REAL), which made the planner believe `typeof(x)` was numeric.

Why that mattered: the comparison emitter in `runtime/emit/binary.ts` (`emitComparisonOp`) uses the operands' logical types to pick a fast path. When one side is numeric, it inserts an implicit `Cast(... AS REAL)` on the other side. For `typeof(x) = 'integer'`, that cast lands on the literal `'integer'` and forms a `Cast(Literal('integer') AS REAL)` subtree — which is fully const, so `const-pass.ts` folds it to `0`. The CHECK then evaluates `'integer' = 0` at row time and rejects every insert.

Pinning the return type to TEXT removes the false numeric affinity, so no implicit cast is inserted and the comparison runs as text-vs-text — which is what SQLite documents (`typeof()` always yields one of `'null' | 'integer' | 'real' | 'text' | 'blob'`).

## Use cases & validation

The fix targets CHECK predicates and any expression that compares `typeof(x)` to a literal:

```sql
create table t_typ (
  id integer primary key,
  x any,
  check (typeof(x) in ('integer', 'real'))
);
insert into t_typ values (1, 10);    -- now succeeds (was: CHECK failed)
insert into t_typ values (2, 'abc'); -- still fails (typeof='text')
insert into t_typ values (3, 1.5);   -- now succeeds
```

Verification:

- `node ./node_modules/mocha/bin/mocha.js packages/quereus/test/logic.spec.ts --grep "40\.2-check-extras"` → 1 passing.
- Full `yarn workspace @quereus/quereus test` → 993 passing, 1 pre-existing failure in `Predicate normalizer / double negation` that reproduces on `main` without these changes (unrelated to this ticket).
- `yarn workspace @quereus/quereus typecheck` → clean.

Note on the "vitest spec" todo from the source ticket: upstream's `packages/quereus` test harness is mocha+ts-node — it does not have a vitest runtime. The bug surfaced under vitest+dist (downstream consumers) because the fold ordering happened to differ from mocha+ts-node, but the underlying plan shape was reachable in both. With `typeof`'s return type pinned, the plan never inserts the lossy cast in either path, so adding a separate vitest spec to upstream is not necessary; the existing `40.2-check-extras.sqllogic` is sufficient and the downstream lamina-quereus-test consumer can drop its `TYPEOF_CHECK_CONSTANT_FOLD` known-failure entry.

## Audit notes (other text-returning scalars)

Per the source ticket's complementary cleanup ask, audited `scalar.ts` and `string.ts`:

- `scalar.ts`: `typeof` was the only text-returning scalar without an explicit return type. All other text-shaped helpers (`coalesce`, `iif`, `nullif`, `choose`, `greatest`, `least`) already use `inferReturnType` to compute the right type from arguments. There is no `printf` registered.
- `string.ts`: every text-returning function (`substr`, `substring`, `lower`, `upper`, `trim`, `ltrim`, `rtrim`, `replace`, `reverse`, `lpad`, `rpad`) already attaches `textReturnTypeInference` (TEXT). Latent but separate: `like` and `glob` return boolean (1/0) without a registered type, and `random`/`randomblob` in `scalar.ts` return INTEGER/BLOB without one. None of these is text-shaped, none is a current bug, and they're out of scope for this ticket — flagging here in case a follow-up sweep wants to tighten them.

## Review checklist

- [ ] `typeofFunc` exports an explicit `returnType` whose `logicalType` is `TEXT_TYPE` and `nullable: false`.
- [ ] No other call site relied on `typeof()` reporting a numeric type — search for `typeof(` usages in tests/docs and confirm they expect a text comparison shape.
- [ ] `40.2-check-extras.sqllogic` still passes; in particular the `insert into t_typ values (2, 'abc')` case still rejects (text fails the `in ('integer', 'real')` check).
- [ ] No other text-returning scalar in `scalar.ts` or `string.ts` relies on the default (REAL) return type — see audit notes above.
- [ ] Downstream lamina-quereus-test can remove the `TYPEOF_CHECK_CONSTANT_FOLD` known-failure entry once a release containing this fix lands.
