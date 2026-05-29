description: Row-time (write-through) materialized-view maintenance for the covering-index shape — a `row-time` refresh policy that keeps a covering MV's backing table consistent synchronously with each source row-write (same transaction, visible mid-statement), not at COMMIT. Maintenance capability only; UNIQUE enforcement routing is the downstream `covering-structure-mv-rowtime-enforcement` ticket. Reviewed and accepted; no code changes required in review.
files: packages/quereus/src/schema/view.ts, packages/quereus/src/parser/ast.ts, packages/quereus/src/parser/parser.ts, packages/quereus/src/planner/nodes/materialized-view-nodes.ts, packages/quereus/src/runtime/emit/materialized-view.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/core/database.ts, packages/quereus/src/core/statement.ts, packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic, docs/materialized-views.md, docs/incremental-maintenance.md, docs/lens.md
----

## Summary

A third refresh policy, **`row-time`**, gated at create to the covering-index shape.
For an eligible MV the backing table is maintained synchronously with each source
row-write — within the writing transaction, visible mid-statement (reads-own-writes),
committed/rolled-back in lockstep with the source write — by a pure projection of the
changed row (delete old image's backing key, upsert new image). No body
re-execution, no scan, no compiled residual.

This delivers the maintenance capability only. Enforcement routing
(`findIndexForConstraint` returning the `materialized-view` variant;
`checkSingleUniqueConstraint` consuming the backing table) is untouched — that is the
downstream `covering-structure-mv-rowtime-enforcement` ticket.

Implementation tour: see the implement-stage commit
`ticket(implement): materialized-view-rowtime-write-through` (242e75a0) and the prior
review/handoff notes. Key pieces: `RefreshPolicy` gains `{kind:'row-time'}`
(`schema/view.ts`); parser accepts `with refresh = 'row-time'` (note: the clause
follows the view body); eligibility + plan in `database-materialized-views.ts`
(`buildRowTimePlan`, cached in `rowTime` / `rowTimeBySource`, released via
`releaseRowTime`); privileged transactional write
`MemoryTableManager.applyMaintenanceToLayer`; synchronous hook
`maintainRowTimeStructures` called from `dml-executor.ts` at all six
`_recordInsert/_recordUpdate/_recordDelete` sites, guarded by the cheap
`_hasRowTimeCoveringStructures`; the backing write rides the same connection a
`select` from the MV uses (`getBackingConnection`); `statement.ts`
`resolveMaterializedViewSource` projects a row-time MV's backing reference to its
sources.

## Validation

- `yarn build` (monorepo): clean.
- `yarn lint` (quereus): clean (0 errors / 0 warnings).
- `yarn test` (quereus, memory): **3797 passing, 9 pending, 0 failing** — green at
  review (verified with `LOGIC_FILE` unset; a filtered run reports 854 + the one
  logic file, which is expected, not a regression).
- No code or test changes were made during review (see Review findings → Disposition).

## Review findings

Adversarial pass over the implement-stage diff, conducted across five focused review
threads (DML hook sites; eligibility + plan build; manager + transaction
coordination; parser/schema/emit/stringify; test coverage) plus direct verification
of the running engine. **No correctness defect was found in the new code.** Detail by
aspect:

### Correctness — DML hook sites (CLEAN)
All six maintenance hook sites are present and correctly paired with their
`_recordX` calls (insert, INSERT-OR-REPLACE eviction, UPSERT do-update, normal
update, UPDATE-causes-REPLACE eviction, delete). The old/new row images passed to
the hook match what was recorded at every site. The REPLACE-eviction paths correctly
emit two changes (a `delete` for the evicted row + an `insert`/`update` for the
survivor) that net to the correct backing state with no clobber. The guard
(`_hasRowTimeCoveringStructures`) is checked first and is not inverted. The hook is
`async` and awaited at every site; no floating promise.
- *Note:* an initial suspected "missing eviction-delete maintenance" was a false
  alarm from a misread of the file; the real code (a `maintainRowTimeStructures`
  helper) handles it correctly. No change made.

### Correctness — eligibility + plan (CLEAN)
`buildRowTimePlan`'s covering-index gate is sound and conservative. Multi-source
bodies (joins, self-joins, correlated subqueries), aggregates, set ops, DISTINCT,
recursive CTEs, TVFs, LIMIT/OFFSET, expression/computed projected columns, and
projections dropping a source PK column are all rejected. `resolveSourceCol`
correctly resolves aliased passthrough columns (`select id, x as y`) via
`ProjectNode.getProducingExprs`, so valid passthroughs are not wrongly rejected. The
projection array is dense (built via `push`), no sparse-array hazard. `releaseRowTime`
clears both `rowTime` and `rowTimeBySource` on every drop / schema-change /
re-register / dispose path — no leak. Predicate is compiled from the AST `where`
against the source schema via the **shared** `compilePredicate` (not a new
reimplementation), and unknown columns / unsupported forms throw → reject.

### Correctness — manager + transaction coordination (CLEAN)
`applyMaintenanceToLayer` routes ops through `TransactionLayer.recordUpsert` /
`recordDelete`, which maintain secondary indexes incrementally and correctly on the
connection's private pending layer — no stale-index hazard (in fact more precise than
`applyMaintenance`'s full rebuild). The "no latch / synchronous" claim holds (pending
layer is private; the apply body has no `await`). The lazily-created backing
connection inherits the active statement savepoint via `registerConnection`'s
savepoint replay, and commits/rolls-back in lockstep with the source connection
inside the coordinated commit. All four predicate-scope-transition branches and the
delete-old/upsert-new ordering for key-changing updates are correct. No connection
leak.

### Correctness — parser / schema / emit / stringify (CLEAN)
`with refresh = 'row-time'` parses (case-insensitive, consistent with the other
policies); unknown values produce a clear error. `RefreshPolicy` is a proper
discriminated union and every switch/branch over it handles `row-time`. The
ast-stringify round-trip works — the feared hardcoded-`on-commit-incremental` bug
does not exist; the branch is generic. `resolveMaterializedViewSource` projects a
row-time MV's backing reference to its sources, correctly gated to maintained
policies only.

### Major findings → filed as new tickets
- **Test coverage gaps** → `tickets/fix/materialized-view-rowtime-test-coverage.md`.
  The shipped sqllogic covers only 3 of the 6 hook sites (plain insert/update/delete);
  UPSERT do-update, INSERT-OR-REPLACE eviction, and UPDATE-causes-REPLACE eviction are
  untested, as are savepoint `rollback to` (backing-connection lazy-attach), NULL /
  3-valued partial predicates, key-colliding updates, and ALTER/DROP-source
  re-registration. §8 (all rejections assert the same `row-time` substring) and §9
  (asserts source count, not backing detach) are weak. The code is correct; this is
  regression-hazard coverage debt. **Discovered during review:** `UPDATE OR REPLACE`
  does not parse in Quereus (`near "or": syntax error`), so the UPDATE-causes-REPLACE
  eviction hook site may be unreachable from SQL — the ticket calls for confirming the
  trigger mechanism before testing it. (I attempted to add an inline `update or
  replace` regression test for the eviction path; it could not be expressed because of
  this parser limitation, so it was reverted and folded into the coverage ticket.)
- **UPDATE/DELETE statement-level atomicity** →
  `tickets/backlog/dml-update-delete-statement-atomicity.md`. Pre-existing: `runInsert`
  wraps each statement in a savepoint but `runUpdate`/`runDelete` do not, so a
  mid-statement throw inside an explicit transaction leaves earlier rows of the
  statement applied. Autocommit is atomic (implicit-txn rollback); source and backing
  never diverge (lockstep). Row-time adds a new throw site to these loops, widening the
  surface, hence flagged — but the gap predates this work and needs design.

### Minor findings → filed as cleanup ticket
`tickets/backlog/rowtime-mv-minor-cleanups.md`: the `change` payload should be a
discriminated union (retire the `!` asserts in `applyRowTimeChange`; de-duplicate the
inline type across three files); duplicated `tableKey` string at hook sites; cosmetic
`as Row` / `as unknown as Database` casts; an explicit window-function reject would be
more robust than the current structural one; `getBackingConnection`'s O(active
connections) per-row scan (fine for v1). Also documented there: a **pre-existing,
engine-wide** divergence between `compilePredicate`'s truthiness and the canonical
`isTruthy` (affects partial indexes / partial UNIQUE too, not just row-time) that can
make a bare-column/string/blob/NaN partial predicate disagree with the SELECT body —
inherited, not introduced here.

### Docs
`docs/materialized-views.md`, `docs/incremental-maintenance.md`, and `docs/lens.md`
were updated by the implement stage and reflect the row-time policy, the covering-index
eligibility shape, and the synchronous write-through semantics. Verified consistent
with the shipped behavior.

### Disposition
No minor finding was both safe and self-contained enough to fix inline without risking
the green build (the type cleanups span three files; the truthiness item is engine-wide
and pre-existing). All actionable items are routed to the three follow-up tickets
above. The feature ships as implemented: build clean, lint clean, full memory test
suite green (3797 passing / 9 pending / 0 failing).
