---
description: Gate the `NOT col → eq-literal{col, 0}` rewrite on column-is-numeric in both the producer (partial-UC FD extraction) and the consumer (Filter guard activation). For TEXT/BLOB/BOOLEAN/OBJECT columns the rewrite is unsound because the consumer matches the guard via strict `sqlValueEquals` and TEXT `''` / boolean `false` compare unequal to integer `0`, so the rewrite would falsely discharge a guard the runtime UC never enforced. INTEGER/REAL/NUMERIC behavior is unchanged.
files:
  packages/quereus/src/planner/util/fd-utils.ts
  packages/quereus/src/planner/nodes/filter.ts
  packages/quereus/src/planner/analysis/partial-unique-extraction.ts
  packages/quereus/test/optimizer/conditional-fds.spec.ts
  packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic
  docs/optimizer.md
---

## Change summary

- **Consumer (`fd-utils.ts`)**: extended `predicateImpliesGuard` and the internal `buildPredicateFacts` with an `isColumnNumeric: (col: number) => boolean` callback (mirrors the existing `isColumnNonNullable` plumbing). In the `UnaryOpNode` `'NOT'` branch of `buildPredicateFacts`, the `literalEqs.set(cIdx, 0)` line is now gated on `isColumnNumeric(cIdx)`. `isNotNullCols.add(cIdx)` still fires regardless of type — that's sound for any column.
- **Filter wiring (`filter.ts`)**: `FilterNode.computePhysical` now builds an `isColumnNumeric` closure from `sourceAttrs[col].type.logicalType?.isNumeric === true` and threads it to `activateGuardedFds` → `predicateImpliesGuard`.
- **Producer (`partial-unique-extraction.ts`)**: added an `isColumnNumericDeclared` helper alongside the existing `isColumnNotNullDeclared`. Threaded through `recognizeGuardClauses` / `recognizeClause` / `recognizeOr`. The `UnaryExpr` `'NOT'` branch now rejects unless both `isColumnNotNullDeclared(col)` and `isColumnNumericDeclared(col)` hold. Docstrings at the top of the file and on `recognizeClause` updated to describe the new gate.
- **Docs (`docs/optimizer.md`)**: updated three references — the producer rewrite table, the soundness paragraph after it, and the `predicateImpliesGuard` signature lines — to mention the numeric-only gate.

`BOOLEAN_TYPE` deliberately has `isNumeric: undefined` (it's a truth type; `compareSqlValuesFast(false, 0) !== 0`). It is therefore *not* covered by this rewrite — `NOT bool_col` is `bool_col = false`, not `bool_col = 0`. That's correct conservative behavior; symmetric `WHERE col = false` handling is a follow-up that requires `literalEqs` to accept a per-column set.

## Use cases to validate

### Bug regression (the case the ticket is about)

```sql
create table t (id integer primary key, c integer not null, val text not null) using memory;
create unique index ix on t(c) where val = 0;
insert into t values (1, 1, '');
insert into t values (2, 1, '');
select c, count(*) as n from t where not val group by c order by c;
-- expect: [{"c":1,"n":2}]   (NOT '' is truthy under SQLite, but partial UC predicate val=0 doesn't match val='')
```

Before the fix the planner would treat `WHERE NOT val` as discharging the partial UC's `val = 0` guard and fire `c → {…}` over rows that share `c=1`, breaking DISTINCT / aggregate-elimination.

Covered by the new `§7j-NOT-on-TEXT` block in `test/logic/10.5.1-partial-indexes.sqllogic` plus its INT-column mirror that confirms the feature isn't regressed for numeric columns.

### Producer-side (unit)

Added in `conditional-fds.spec.ts`:

- `'rejects NOT col on declared-NOT-NULL TEXT column (numeric-only rewrite)'` — TEXT-typed UC column with `WHERE NOT flag` predicate produces no FD.

Existing tests still cover the INT case (`'recognizes NOT col on declared-NOT-NULL column as eq-literal { col, 0 }'`).

### Consumer-side (unit)

Added in `conditional-fds.spec.ts`, alongside the existing `NOT col` tests:

- `"NOT col on TEXT column does NOT discharge eq-literal{col, 0} guard (numeric-only rewrite)"` — uses `noneNumeric` callback, expects `false`.
- `"WHERE col = 0 on TEXT column still discharges eq-literal{col, 0} guard (= path unaffected)"` — direct `col = 0` conjunct, expects `true`. Documents the intentional asymmetry: only the `NOT col` rewrite is gated; `=` accepts the equality at face value.
- `"NOT col on INTEGER column still discharges eq-literal{col, 0} guard (feature regression guard)"` — uses `allNumeric` callback, expects `true`.

Test helpers `allNumeric` and `noneNumeric` were added next to the existing `allNullable` / `nonNullable` helpers; every prior `predicateImpliesGuard` call was extended to pass `allNumeric` so existing tests (all on INTEGER columns) continue to pass.

## Validation

- `yarn workspace @quereus/quereus run test` → **3103 passing**, 2 pending (no new failures).
- `yarn workspace @quereus/quereus run lint` → clean.

## Known gaps / risks

- **Asymmetry is intentional.** A test (`"WHERE col = 0 on TEXT column still discharges …"`) documents that `col = 0` on a TEXT column still discharges the guard. This is a deliberate consumer choice: `eq-literal { col, value: 0 }` is matched literally via `sqlValueEquals`, and a literal `col = 0` predicate is treated as a faithful match regardless of column type. In SQLite storage-class semantics `col = 0` on a TEXT column would generally not match `val = '0'` rows under strict comparison, so this isn't a soundness concern for the partial-UC FD use case — but a reviewer should confirm there's no other producer that emits `eq-literal { col, value: 0 }` with a meaning of "boolean false" rather than "integer 0". A quick grep on `value: 0` and `eq-literal` showed only the `NOT col` rewrites at the producer and consumer; no other producers found.
- **The numeric gate uses `logicalType?.isNumeric === true`.** `INTEGER_TYPE`, `REAL_TYPE`, `NUMERIC_TYPE` set this. `TEXT_TYPE`, `BLOB_TYPE`, `BOOLEAN_TYPE`, `ANY_TYPE` do not. `BOOLEAN_TYPE` columns therefore fall through the gate even though `NOT bool_col` *is* meaningfully `bool_col = false` (just not `= 0`). This is the conservative-correct choice (the ticket explicitly defers boolean-set support to a follow-up); please confirm no current schema relies on the partial-UC-on-BOOLEAN feature.
- **`isColumnNumeric` callback in the consumer is required.** Adding a non-optional parameter to `predicateImpliesGuard` was the simplest plumbing — all production and test callers were updated. If you'd prefer it optional (default: skip the pin), happy to revise; the test suite uses both `allNumeric` and `noneNumeric` so making it optional wouldn't simplify the tests.
- **No new producer for `WHERE col` (truthy test)** — out of scope per the ticket. The producer still only recognizes `NOT col`, not the inverse.
- **No casts/function-wrapped column references** in the `NOT col` branch — out of scope.
- **sqllogic coverage is intentional but light.** The `§7j-NOT-on-TEXT` case asserts the row count is correct (the symptom is wrong row counts from a misfiring FD). It does not assert at the plan layer that the FD is absent — that's covered by the unit-level test on `predicateImpliesGuard`. A reviewer who wants belt-and-suspenders coverage could add an end-to-end test that inspects `query_plan(...)` output similar to the existing 7j INT case in `conditional-fds.spec.ts`.

## Out-of-scope follow-ups (not done; ticket explicitly defers)

- BOOLEAN column support for `NOT col` (needs per-column literal sets in `literalEqs`).
- Symmetric handling of `WHERE col` (truthy test) on the producer/consumer.
- Casts/function-wrapped column references in the `NOT` branch.
