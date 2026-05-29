description: Row-time UNIQUE enforcement routed through an explicit `row-time` covering materialized view's backing table. `findIndexForConstraint` now returns the `materialized-view` covering variant (in preference to the auto-index) when a linked, non-stale, non-diverged row-time covering MV exists; conflict resolution point-looks-up the MV's backing table to recover the conflicting source PK so REPLACE/IGNORE/ABORT resolve against the correct source row. Implemented for the memory source and the direct store source; reviewed and accepted.
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/core/database.ts, packages/quereus/src/core/database-internal.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/index.ts, packages/quereus/src/schema/table.ts, packages/quereus/src/schema/view.ts, packages/quereus-store/src/common/store-table.ts, packages/quereus/test/covering-structure.spec.ts, packages/quereus/test/logic/54-covering-mv-enforcement.sqllogic, packages/quereus-store/test/unique-constraints.spec.ts, docs/materialized-views.md, docs/lens.md
----

## Summary

Made the `materialized-view` arm of `CoveringStructure` a live UNIQUE-enforcement path.
A linked `row-time` covering MV (`select <uc-cols>, <pk> from T order by <uc-cols> with
refresh = 'row-time'`) is resolved by `Database._findRowTimeCoveringStructure` (O(1)
negative fast path off `rowTimeBySource`, gated on non-stale/non-diverged) and, when
present, answers conflict resolution **in preference to** the auto-index. The
`materialized-view` arm point-looks-up the backing table
(`Database._lookupCoveringConflicts`, reads-own-writes), recovers each conflicting
**source** PK from the MV projection, validates it against the live source row (skipping
stale backing candidates), and applies IGNORE/ABORT/REPLACE. REPLACE evictions are done
directly on source storage and so drive `_maintainRowTimeCoveringStructures(delete)` to
keep the backing consistent mid-statement. Mirrored on the direct store path in
`store-table.ts`.

See implementation detail in the git history (`ticket(implement):
covering-structure-mv-rowtime-enforcement`, commit 7958d4e9).

## Review findings

### Validation run (all green)

- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus run typecheck` — clean.
- Full memory suite (`yarn workspace @quereus/quereus test`) — **3813 passing, 9 pending,
  0 failing** (baseline was 3810; +3 from the new specs).
- `@quereus/store` package suite — **274 passing, 0 failing** (the logged "boom" line is
  an intentional data-change-listener fixture).
- `54-covering-mv-enforcement.sqllogic` under store isolation (`--store --grep 54-covering`)
  — **1 passing**.
- Did NOT run the full `yarn test:store` sweep (~10 min, idle-timeout risk under tess);
  ran the targeted `54` file under store mode plus the store package suite instead, per
  the implementer's deferral. Left to CI.

### Correctness / soundness — checked, no defects

- **The conflict gate** (generator over-produces candidates from a backing scan;
  validator narrows to live-source match + `newSourcePk` self-exclusion). Re-derived
  against multi-row statements, REPLACE chains, and PK-changing UPDATEs. The liveness
  validation + self-exclusion together neither miss a real conflict nor raise a phantom
  under the current invariants (internal mutations on this path are deletes, not
  scope-changing updates). Covered by the new specs (intra-statement dup, PK-only self-move,
  PK-change-onto-existing, schema-level `on conflict replace`).
- **No double-maintenance.** The DML-executor row-time hook maintains the outer statement
  row; the internal-eviction maintenance maintains the *evicted* row — different rows, no
  overlap. Confirmed.
- **Newly-async propagation.** `checkUniqueConstraints` / `checkSingleUniqueConstraint` /
  `performUpdateWithPrimaryKeyChange` became `async`; verified every call site is awaited
  (both INSERT and UPDATE paths, PK-change branch, and store).
- **Partial covering MV.** Source-side scope skip uses `uc.predicate` for the MV case
  (aligned with the prover's WHERE). Covered by the partial-MV spec.

### Collation — investigated; NOT a regression (pre-existing gap filed)

The generator (`lookupCoveringConflicts`) matches UC values with the source column's
collation, but both validators (`checkUniqueViaMaterializedView`, store
`findUniqueConflictViaCoveringMv`) re-match with default-BINARY `compareSqlValues`. I
suspected a missed-conflict regression for a `NOCASE`/`RTRIM` UNIQUE (since the MV is now
preferred over the collation-aware index) and **reproduced** it empirically (`'abc'` then
`'ABC'` under a NOCASE UNIQUE + row-time covering MV → no conflict). But the **control**
(no covering MV, auto-index path) behaves identically — the auto-built UNIQUE index drops
the column's declared collation (`ensureUniqueConstraintIndexes`, manager.ts:176, builds
`{ index }` with no `collation`). So this is a **pre-existing, engine-wide** soundness gap
(UNIQUE ignores column collation), and the covering-MV path nets out *consistent* with the
auto-index path — not a new defect. Filed as
`tickets/backlog/unique-constraint-ignores-column-collation.md` (broader than this feature;
includes fixing the validator re-matches to be collation-aware alongside the auto-index).

### Minor observations (left as-is, documented)

- **Validator predicate asymmetry.** The store validator re-checks the candidate's live
  row against the partial predicate (`predicate.evaluate(liveRow)`); the memory validator
  does not. Safe under current invariants (the backing holds only in-scope rows and
  internal mutations are deletes), so not reachable — left for symmetry cleanup rather than
  churning a green build.
- **`DatabaseInternal` is cross-package `any`** (stripped from emitted `.d.ts`). Consistent
  with the pre-existing `registerConnection` pattern; the interface additions are correct
  and documentary. Accepted.
- **`resolveCoveringStructureName` column-match** is ambiguous for a degenerate table with
  two UCs over the same column list. Acceptable for v1.

### Docs — verified current

`docs/materialized-views.md` § "Enforcement through a row-time covering MV" and the
`schema/table.ts` / `schema/view.ts` field comments accurately describe the delivered
behavior, the preference tradeoff, the eviction-maintenance edge, store parity, and the
isolation-path limitation. `docs/lens.md` § Constraint Attachment flipped from deferred to
delivered. No staleness found.

### Major findings → follow-up tickets filed

1. **Performance / preference** —
   `tickets/backlog/covering-mv-enforcement-prefix-scan-and-preference.md`. The v1 conflict
   check is a full backing scan, and the MV is preferred over the auto-index even for
   physical tables, so a bulk insert on such a table degrades to O(n²). Add the backing-PK
   prefix scan and decide whether the auto-index should win for physical schemas until then.
   (Intended v1 tradeoff per the implementer; tracked for follow-up.)
2. **Isolation-layer routing** —
   `tickets/backlog/covering-mv-isolation-layer-enforcement-routing.md`. The
   isolation-wrapped store path enforces UNIQUE via its own merged-view detection and never
   routes through the covering MV, so the MV backing is not maintained for that layer's
   internal evictions. Decide whether to route it (and then add the omitted backing-
   consistency assertions to `54`).
3. **Pre-existing collation gap** —
   `tickets/backlog/unique-constraint-ignores-column-collation.md` (see Collation above).
