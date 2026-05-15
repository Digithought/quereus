---
description: Review the soundness fix that excludes partial UNIQUE constraints (those carrying a `predicate`) from `RelationType.keys` derived from `TableSchema`, so the FD layer no longer derives `K → all-other-cols` over the whole table for partial-unique columns.
files:
  packages/quereus/src/planner/type-utils.ts
  packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic
  packages/quereus/src/planner/nodes/reference.ts
  packages/quereus/src/schema/table.ts
---

## Summary

One-line change in `relationTypeFromTableSchema` (`packages/quereus/src/planner/type-utils.ts:41-58`):
the UNIQUE→key promotion now additionally requires `uc.predicate === undefined`.
A partial UNIQUE constraint synthesized from `CREATE UNIQUE INDEX ... WHERE ...`
only guarantees uniqueness within the WHERE scope, so it must not be promoted
to a relation-level key — otherwise `TableReferenceNode.computePhysical`
(`packages/quereus/src/planner/nodes/reference.ts:81-101`) materializes the
unsound FD `K → all-other-cols`, and every downstream FD consumer (DISTINCT
elimination, GROUP BY simplification, ORDER BY pruning, FK→PK join elimination,
predicate-inference equivalence classes) silently produces wrong answers for
rows outside the partial scope.

The comment block above the loop was expanded to document why partial UNIQUEs
are excluded and to point at the conditional-FD optimization backlog ticket
(`fd-conditional-fd-from-partial-unique-index`).

No public surface change. Soundness restored for every downstream FD consumer
automatically — no per-rule edits needed.

## Validation performed

- `yarn workspace @quereus/quereus run test`: **2942 passing, 2 pending, 0 failing** (46s).
- `yarn workspace @quereus/quereus run lint 'src/**/*.ts'`: exit 0.
- Did **not** run `yarn test:store` (out of scope for this fix; this is purely
  a planner-side schema→type translation, not a store-level change).

## Regression test added

New section 6 + positive control appended to
`packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic`:

- `p_fdkey` with a partial UNIQUE index `(c) where status='active'`, with two
  rows sharing `c='A'` (one active, one inactive) and a third `c='B'`:
  - `select c from (select distinct c from p_fdkey) order by c` must return
    both `'A'` and `'B'` (DISTINCT must not be eliminated).
  - `select count(distinct c) from p_fdkey` must return 2.
  - LEFT JOIN driven by `p_fdkey_drv(c='A')` joining on partial-UNIQUE `c`
    must return 2 rows, not 1 (FK→PK-style join elimination must not fire).
- `p_fdkey_full` positive control: a *full* UNIQUE index on a NOT NULL
  column on the same shape still gets the FD and DISTINCT may still be
  eliminated — confirms we didn't regress the happy path.

Before the fix, the DISTINCT-elimination test would have returned 2 rows from
the inner SELECT (both base rows, deduped by `c='A'` → 1 row outside; wait —
re-reading: the bug surface was that `select distinct c` returned 2 rows of
`c='A'` because DISTINCT was eliminated entirely, leaving the base rowset.
Result count would mismatch). After the fix, the inner SELECT correctly
deduplicates and the count form returns 2.

## What to review carefully

- **Is `uc.predicate === undefined` the right discriminator?** Confirm that
  every partial-UC path (via `CREATE UNIQUE INDEX … WHERE …`, via
  `schemaManager.addIndexToTableSchema`, etc.) sets `predicate`. Spot-check
  `packages/quereus/src/schema/table.ts` UniqueConstraintSchema construction
  sites and the index-driven synthesis path.
- **Is there any other place in the planner that derives keys/FDs from
  `tableSchema.uniqueConstraints` directly** (bypassing
  `relationTypeFromTableSchema`)? If so, it has the same bug and needs the
  same gate. A `find_references` on `uniqueConstraints` is worth doing.
- **Are there downstream consumers that read partial-UC info from a
  different field** (e.g., from `indexes` rather than from `keys`)? The fix
  here only narrows `RelationType.keys`. If anything reads
  `uc.columns` directly as a key, it would still be wrong.
- **Plan-level assertions** in `packages/quereus/test/optimizer/` or
  `packages/quereus/test/planner/` were not specifically audited for
  partial-UNIQUE plan shapes; the result-level tests in section 6 pin user
  semantics, but if you want a plan-shape assertion that the `Distinct` node
  is preserved with a partial UNIQUE, that's a fair add.

## Out of scope (deferred)

`tickets/backlog/fd-conditional-fd-from-partial-unique-index.md` covers the
actual optimization opportunity: when a query's effective predicate implies
the partial UNIQUE's `WHERE`, the FD layer *could* derive the same key —
just conditionally. That requires teaching the FD layer about conditional
FDs (or rewriting the partial UC into a "scope view" with its own FDs). Not
attempted here; this ticket is purely the soundness stop-gap.
