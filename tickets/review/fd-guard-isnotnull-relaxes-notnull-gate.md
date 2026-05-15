---
description: Review the relaxation of the NOT-NULL gate in `extractPartialUniqueGuardedFds` so a nominally nullable UC column is admitted when the partial predicate contains a matching `col IS NOT NULL` conjunct.
prereq:
files:
  - packages/quereus/src/planner/analysis/partial-unique-extraction.ts
  - packages/quereus/test/optimizer/conditional-fds.spec.ts
  - packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic
---

## What landed

`extractPartialUniqueGuardedFds` in
`packages/quereus/src/planner/analysis/partial-unique-extraction.ts` now
admits a nominally-nullable UC column when the partial predicate's
AND-conjunctive clauses already include a matching `col IS NOT NULL`
conjunct. The producer:

1. Recognizes guard clauses first (moved above the gate).
2. Builds `nonNullByPredicate: Set<number>` from clauses where
   `kind === 'is-null' && negated === true`.
3. Admits each UC column when `column.notNull === true` **or**
   `nonNullByPredicate.has(idx)`; otherwise skips the whole UC.

Soundness rests on Filter activation: the FD only discharges when the
surrounding predicate entails every guard clause — and `col IS NOT NULL`
is itself one of those clauses — so the guard can't be relaxed for rows
where the UC column might be NULL.

The header comment block was updated:
- NOT-NULL gate doc-comment now describes the relaxation explicitly.
- "IS-NOT-NULL discharge for nominally-nullable UC columns" was removed
  from the out-of-scope list.

## Test additions

### Unit tests (`packages/quereus/test/optimizer/conditional-fds.spec.ts`)

Inside `describe('extractPartialUniqueGuardedFds', ...)`, alongside the
existing `'rejects nullable UC column (NOT-NULL gate)'` (untouched):

- Positive: nullable UC col with `IS NOT NULL` on that col → admitted.
- Positive: composite UC where every nullable col has its own
  `IS NOT NULL` conjunct → admitted.
- Negative: `IS NOT NULL` names a different column → rejected.
- Negative: composite UC where only one of two nullable cols has
  `IS NOT NULL` → rejected.
- Negative: `IS NULL` (non-negated) does NOT satisfy the gate.

### Sqllogic (`packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic`)

New section **7h** at the end. Pins runtime correctness for the new
admit case: a partial unique index on a nullable `email` column with
`WHERE email IS NOT NULL` — DISTINCT must yield 2 inside scope (two
non-null emails are unique) and 3 across the table (NULL counts as
distinct). Existing **7g** (nullable UC with `WHERE status = 'active'`,
where the predicate does NOT force the UC column non-NULL) remains
unchanged — that case must still produce no FD.

## Validation done

- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus run test --grep "extractPartialUniqueGuardedFds|Partial UNIQUE"`
  — 26 tests passing (covers all five new unit tests plus the
  existing end-to-end partial-UNIQUE → guarded FD propagation tests).
- `yarn workspace @quereus/quereus run test --grep "10.5.1"` — sqllogic
  fixture passes, exercising new section 7h.
- `yarn test` (full workspace) — quereus core 3030 passing, 2 pending.
  Two **pre-existing, unrelated** failures in `@quereus/sample-plugins`
  (`key_value_store virtual table > supports delete/update`); verified
  by stashing the diff and running `yarn workspace @quereus/sample-plugins
  run test` on clean tip — same failures. These touch plugin
  delete/update behavior in the key_value_store vtab, nothing to do
  with FD analysis.
- `yarn test:store` — skipped per ticket (orthogonal to FD analysis).

## Use cases for the reviewer to probe

- **Soundness corner: discharging filter doesn't entail IS NOT NULL.**
  If a future change to `predicateImpliesGuard` ever treated an
  `IS NOT NULL` guard clause as "always satisfied" when the column is
  *nominally* nullable, the relaxed gate here would silently
  break — the FD would activate for filters that don't actually
  exclude NULLs. Worth confirming that
  `predicateImpliesGuard` still requires the predicate to entail
  the `IS NOT NULL` clause via a predicate conjunct, an EC, or a
  bound non-null literal — never via "column is nominally nullable".
  (Existing test `'is-null negated via non-nullable column metadata'`
  in conditional-fds.spec.ts shows the bypass works the other way:
  when the column is non-nullable, the guard auto-satisfies — that's
  fine and unrelated to this change.)
- **Composite UC mixed with eq-literal:** UCs like
  `(email, region) WHERE email IS NOT NULL AND region = 'us'` — the
  region clause is eq-literal, not IS NOT NULL, so the relaxation
  only covers `email`. If `region` is declared NOT NULL on the
  table the UC admits; if `region` is nullable, the UC is rejected.
  Worth a sanity test if you want to pin that combination
  explicitly — current tests cover the two pure shapes (all-IS-NOT-NULL
  and all-NOT-NULL-table-declared) but not the mixture.
- **Multi-NULL within scope:** in the new sqllogic table `p7h`, the
  insert `(3, null)` lives *outside* the partial scope, so the unique
  index doesn't fire on it. Good. A negative-case insert that
  attempts a second NULL-bearing row inside scope is impossible
  because the partial predicate `email IS NOT NULL` excludes them by
  construction — so there's no need to add a duplicate-NULL-rejected
  insert; the relaxation is sound exactly because rows that could
  violate uniqueness with NULL are predicate-excluded.

## Surprises

- None substantive. The producer already encoded `IS NOT NULL` as
  `{ kind: 'is-null', column, negated: true }`, so the change was
  almost mechanical — reorder the recognizer above the gate, build
  the set, OR it into the per-column check.
- The existing `'rejects nullable UC column (NOT-NULL gate)'` unit
  test and 7g sqllogic section both use `status = 'active'` (not an
  IS-NOT-NULL conjunct) over a nullable column, so they were
  unaffected by the relaxation and continue to pass — exactly the
  symmetry the ticket called for.
