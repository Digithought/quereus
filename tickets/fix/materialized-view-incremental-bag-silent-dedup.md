description: An `on-commit-incremental` materialized view with a row-preserving bag body (a projection that drops the source key, e.g. `select status from orders`) is incremental-eligible and, when a post-create source mutation introduces a duplicate, the per-binding `upsert` silently collapses the colliding rows to the MV's set key instead of raising the `materializedViewNotASetError` "must be a set" diagnostic. This contradicts the bag-body decision ("no silent de-dup") that the create/refresh full-rebuild path enforces loudly, leaving the two maintenance paths inconsistent.
prereq:
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/test/logic/51-materialized-views.sqllogic, docs/materialized-views.md
----

## Symptom (confirmed reproduction)

```sql
create table orders (id integer primary key, status text);
insert into orders values (1, 'open'), (2, 'shipped');   -- statuses distinct at create
create materialized view mv as select status from orders with refresh = 'on-commit-incremental';
-- create SUCCEEDS: the body is duplicate-free now, so the create-time
-- replaceBaseLayer fill (all-columns key {status}) passes.

insert into orders values (3, 'open');                   -- status 'open' now duplicated in source
-- commit fires incremental maintenance
select * from mv order by status;
-- → [{"status":"open"},{"status":"shipped"}]   -- the duplicate was SILENTLY de-duplicated
```

The same body driven through the **create** path with duplicate initial data,
or through **manual `refresh`** after the duplicate appears, fails loudly with:

> `materialized view '...' body produces duplicate rows, but a materialized view
> must be a set ...`

So the contract is enforced on the full-rebuild path (`rebuildBacking` →
`replaceBaseLayer`, which carries the `onDuplicateKey` factory) but **not** on
the per-binding incremental path.

## Why it happens

`MaterializedViewManager.compile()` in `database-materialized-views.ts` decides
incremental eligibility from the **source's** key, not the MV's output key. For
a non-aggregate (row-preserving) single-source body it sets
`{ kind: 'row', keyColumns: <source PK> }` (see ~line 276) and only rejects when
the source has *no* PK. A projection that drops the source key — `select status
from orders` — is therefore accepted even though its MV backing key is the
all-columns key `{status}` and the body is a bag relative to that key.

At maintenance time the per-binding apply does delete-then-`upsert` keyed by the
MV's physical PK (`MemoryTableManager.applyMaintenance`, the `'upsert'` op:
*find key → if present deleteAt → insert*). On a key collision it overwrites
rather than detecting the duplicate — there is no `onDuplicateKey` hook on this
path, by design (incremental maintenance must not throw on a key it expects to
replace). Net effect: a late bag silently converges to the set.

Note: the **delete** case happens to stay correct in the probe (deleting one of
two source rows that map to the same MV key does not phantom-delete the surviving
row), so this is silent de-duplication, not data corruption — but it still
violates the stated "no silent de-dup" contract and is inconsistent with
create/refresh.

## Decision needed

Two coherent resolutions; pick one (may warrant a short design note / human
sign-off, since the bag-body ticket's decision was explicit):

1. **Reject at incremental-registration (match create/refresh).** In `compile()`,
   detect that the body's output is not provably a set on the backing key
   (i.e. the body can produce duplicate rows under the MV PK — the all-columns
   fallback case where the source key is *not* covered by the projected columns)
   and refuse `on-commit-incremental` with a `must be a set`-style message,
   steering the user to `manual` refresh (which still fails loudly on an actual
   bag). This keeps the "no silent de-dup" contract whole. Reuse the
   effective-key prover (`proveEffectiveKeyUnique` / `keysOf`) rather than a
   bespoke check.

2. **Detect the collision during incremental apply.** Give the per-binding
   `upsert` a way to distinguish "replacing my own prior slice" (legitimate)
   from "colliding with a *different* source row's slice" (a bag) and raise the
   diagnostic in the latter case. Harder — the maintenance path deliberately
   swallows/logs errors post-commit and never rolls the user's commit back, so a
   raise here would have to surface as staleness or a logged contract violation,
   not a thrown error. Likely the wrong layer; option 1 is preferred.

## Interaction with self-healing divergence

`materialized-view-cascading-divergence-propagation` (plan) replaces the Tier-2
hard-error with **live-body fallback + self-triggered repair**. That makes option 1
(reject at incremental-registration) more clearly correct, not less: a bag-capable
body is a *deterministic* rebuild failure, so if it were allowed to register and
later diverge, it would never re-materialize — it would sit in **permanent**
live-body fallback (serving a correct *bag* on read, but never healing, and
tripping a doomed full-rebuild on every read until backoff throttles it). Refusing
the body at create avoids ever entering that degraded-forever state. Keep option 1
as the resolution; this is additional justification, not a new option.

## Acceptance

- A bag-capable row-preserving body under `with refresh = 'on-commit-incremental'`
  no longer silently de-duplicates a late duplicate: either it is rejected at
  create with a clear diagnostic (option 1), or the contract is consciously
  redefined and documented.
- A sqllogic case in `51-materialized-views.sqllogic` §9 (or a focused spec)
  covers the chosen behavior end-to-end (create distinct → source mutation makes
  it a bag → commit → assert the chosen outcome).
- `docs/materialized-views.md` Limitations + PK-inference + roadmap entries
  (currently flagging this as a known exception and pointing here) are updated to
  the resolved reality; remove the `materialized-view-incremental-bag-silent-dedup`
  pointers.
