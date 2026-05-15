---
description: When a partial UNIQUE's predicate includes `col IS NOT NULL` (or `col1 IS NOT NULL AND col2 IS NOT NULL` for composite UCs), the UC columns are effectively NOT NULL within the partial scope, so the guarded FD `K → others | P` is safe even when the columns are nominally nullable on the table. Today `partial-unique-extraction.ts` rejects nullable UC columns via a blanket NOT-NULL gate; lift the gate when `P`'s `IS NOT NULL` conjuncts cover the UC columns.
prereq:
files:
  packages/quereus/src/planner/analysis/partial-unique-extraction.ts
  packages/quereus/test/optimizer/conditional-fds.spec.ts
  packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic
---

## Background

`partial-unique-extraction.ts` mirrors the NOT-NULL rule
`relationTypeFromTableSchema` applies to non-partial UCs: a nullable UC column
admits multiple NULLs and so cannot be a key. For partial UCs the same rule is
currently applied unconditionally, but for partial UCs the predicate itself
can force the UC columns to be non-NULL inside the scope, in which case the
guarded FD `K → others | P` is sound.

## Scope

- In `extractPartialUniqueGuardedFds`, soften the NOT-NULL gate: a UC column
  may be nominally nullable on the table if `uc.predicate`'s AND-conjuncts
  include `col IS NOT NULL` for that column.
- Add unit tests for the relaxation (and continue to reject the case where
  the IS-NOT-NULL conjunct names a different column).
- Add a sqllogic positive-discharge case in `10.5.1-partial-indexes.sqllogic`.

## Use cases this unlocks

- `CREATE UNIQUE INDEX ... ON t(email) WHERE email IS NOT NULL` over an
  `email TEXT NULL` column. Today the FD is suppressed because the column
  is nominally nullable; after this ticket, `WHERE email IS NOT NULL`
  discharges and DISTINCT elimination etc. apply.

## Notes

- The recognizer already produces the `is-null negated:true` clause, so the
  bookkeeping is already correct — the gate is just too strict.
- Care must be taken for *composite* UCs: every UC column nominally nullable
  must have its own IS-NOT-NULL conjunct in the predicate.
