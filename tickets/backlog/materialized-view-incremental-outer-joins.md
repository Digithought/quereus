description: Extend `on-commit-incremental` materialized-view maintenance to outer/semi/anti join bodies. The inner-join first cut (`materialized-view-incremental-join-bodies`) rejects `left`/`right`/`full`/`semi`/`anti` joins at create because null-extended and filtered rows complicate the per-source delete-then-recompute slice on the non-row-preserving side.
prereq: materialized-view-incremental-join-bodies
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/test/logic/52-materialized-views-incremental.sqllogic, docs/materialized-views.md
----

## Problem

The inner-join cut accepts multi-source bodies whose joins are all `inner`/`cross`
and rejects every other join type with an UNSUPPORTED diagnostic
("use `manual` refresh"). Outer and semi/anti joins are deferred because:

- An **outer** join emits null-extended rows for unmatched preserved-side rows. A
  change on the *optional* side flips a preserved row between matched and
  null-extended; `injectKeyFilter` on the optional side filters it *before* the
  join, which changes the preserved side's cardinality and yields the wrong slice.
  (The inner-join cut sidesteps this: the optional side is never "clean", so its
  changes already route to full rebuild — but the gate is currently structural, by
  join type, not by per-source cleanliness reasoning.)
- **Semi/anti** joins (often produced from `EXISTS`/`IN` by subquery
  decorrelation) are filters, not row producers — the maintenance model differs.

## Expected behaviour

- An outer/semi/anti join body created `with refresh = 'on-commit-incremental'` is
  accepted (subject to per-source eligibility) instead of rejected at create.
- A mutation to any participating source maintains the MV incrementally where the
  source's change cleanly maps to the backing physical key, and falls back to a
  full rebuild otherwise — never serving stale rows.
- The row-preserving (preserved) side of an outer join should still be able to
  maintain incrementally where its PK covers the physical PK; only the
  optional/filtered side need degrade to rebuild.

## Notes / directions (non-binding)

- The existing `computeDeleteKeyOrder` "PK covers physical PK ⇒ no fan-out ⇒ clean"
  test is likely still the right correctness net; the work is proving the residual
  produces the correct slice for the *preserved* side under an outer join and
  confirming the optional side always degrades to rebuild rather than producing a
  wrong incremental slice.
- Consider whether `injectKeyFilter` on the optional side of an outer join is ever
  sound, or whether such a source must be forced to a `'global'` binding.

## Use case

Denormalized read models that keep parent rows even when a child/lookup is absent
(left-join flatten), maintained at commit.
