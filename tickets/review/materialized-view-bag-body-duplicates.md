description: Review the bag-body materialized-view diagnostic. A duplicate-producing MV body now fails create/refresh with a purpose-built "must be a set" error that names the view and explains the v1 set-semantics contract, instead of the raw `UNIQUE constraint failed: sqlite_mv_<name> PK` that leaked the hidden backing table. Decision was option 1 (clear diagnostic + documented contract); no silent de-dup, no synthetic identity.
prereq:
files: packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/src/runtime/emit/materialized-view.ts, packages/quereus/test/logic/51-materialized-views.sqllogic, packages/quereus/test/materialized-view-diagnostics.spec.ts, docs/materialized-views.md
----

## What shipped

A v1 materialized view is a **keyed derived relation**: its body must produce a
**set** (no duplicate rows under the backing-table key). Enforcement is dynamic
(at fill time, where the collision is already detected with the btree's real
collation/desc/composite-correct key comparison) — keyless bodies are **not**
statically rejected, so a duplicate-free keyless body still materializes on the
all-columns key. Only the *message* changed.

### Approach: caller-supplied duplicate-key error factory

`MemoryTableManager.replaceBaseLayer` gained an optional
`onDuplicateKey?: () => QuereusError` parameter. The manager keeps its exact
(correct) detection and stays generic — when the factory is absent it throws the
original `UNIQUE constraint failed: <table> PK.` message; when present it throws
the factory's error in the duplicate branch. The MV layer owns the user-facing
wording.

- `manager.ts` — added the param + used it in the dup branch; JSDoc updated.
  **`insertRow` was deliberately left untouched** (alter-table rekey path, not
  an MV fill path).
- `materialized-view-helpers.ts` — new exported
  `materializedViewNotASetError(schemaName, viewName)` returning a
  `StatusCode.CONSTRAINT` error (code retained so create's all-or-nothing
  rollback and refresh semantics are unchanged). `rebuildBacking` passes
  `() => materializedViewNotASetError(mv.schemaName, mv.name)`.
- `materialized-view.ts` — create path passes
  `() => materializedViewNotASetError(plan.schemaName, plan.viewName)`.

The exact message:

> `materialized view '<schema>.<name>' body produces duplicate rows, but a
> materialized view must be a set: its body needs a unique key. Add `distinct`, a
> `group by`/aggregation, or project a key column so every row is unique.`

### The three MV fill paths that reach `replaceBaseLayer`

1. **create** — `emitCreateMaterializedView` (wired). Fails loud/immediate on a
   bag body; the existing catch rolls the backing table back so the MV is never
   half-registered.
2. **manual refresh** — `rebuildBacking` (wired). A body duplicate-free at create
   but duplicate-producing after source edits fails here, not at create — the
   documented late-failure mode.
3. **incremental global rebuild** — `database-materialized-views.ts` →
   `rebuildBacking` (inherits the message for free). Bag bodies are
   incremental-ineligible, so this path should not see one in practice.

The only other `replaceBaseLayer` caller is
`test/vtab/concurrent-scan.spec.ts` (disjoint rows, omits the factory) — correct
and still passing.

## Validation done

- `yarn workspace @quereus/quereus run build` — clean.
- Full quereus suite: **3785 passing, 9 pending** (`yarn workspace @quereus/quereus test`).
- Logic suite alone: 205 passing (includes the new `51-...sqllogic` §9).
- New focused spec `materialized-view-diagnostics.spec.ts`: 2 passing.
- Lint clean.

### Test coverage (use cases)

`51-materialized-views.sqllogic` §9 (sqllogic matches a positive substring
`-- error: must be a set`):
- **Bag body fails at create** — `create materialized view mv_status as select
  status from orders` over a duplicate-producing source → `must be a set`.
- **Name freed on rollback** — a follow-up `... select distinct status ...`
  succeeds and returns the de-duplicated rows, proving the failed create did not
  half-register the name.
- **Late duplicate at refresh** — a body distinct at create
  (`select k from u`), then an `update` makes it a bag, then `refresh` → same
  diagnostic at refresh time.
- (Existing line-89 `select y from pt` all-columns-distinct case still passes —
  the regression guard that keyless-but-distinct bodies materialize.)

`materialized-view-diagnostics.spec.ts` (the **negative** assertion sqllogic
cannot express):
- Error message **contains** `must be a set` and the view name `mv_status`, and
  **does not contain** `sqlite_mv_` or `PK.` — locks in that the backing table is
  never named.
- Backing-table rollback re-proven at the API level (distinct body succeeds and
  returns `[{status:'open'},{status:'shipped'}]`).

## Reviewer notes / known gaps (treat tests as a floor)

- **Negative assertion lives only in the spec, not sqllogic.** The `.sqllogic`
  harness (`logic.spec.ts`) only supports a single positive `-- error: <substr>`
  match — no not-contains. So the "message must not name the backing table"
  contract is asserted exclusively in `materialized-view-diagnostics.spec.ts`.
  Confirm that placement is acceptable (the spec was created new; the existing
  `materialized-view-plan.spec.ts` is plan-shape-only, so I did not fold it in
  there).
- **No test exercises path 3 (incremental global rebuild) with a bag body.** By
  design: keyless/bag bodies are incremental-ineligible and rejected at create,
  so there is no natural SQL that drives a bag body through the incremental
  manager's `'global'` rebuild. The path inherits the message structurally via
  `rebuildBacking`; it is covered by inspection, not by a test. If the reviewer
  wants belt-and-suspenders coverage, it would require constructing a backing
  table + manager directly (vtab-level), like `concurrent-scan.spec.ts` does.
- **First-collision reporting.** Like the prior behavior, the factory fires on
  the *first* duplicate key encountered while building the new base layer; a body
  with several distinct duplicate groups reports only the first. Unchanged from
  before — flagging in case the reviewer expected aggregate reporting.
- **Message wording.** The substring tests pin `must be a set` and (negatively)
  `sqlite_mv_`/`PK.`. The rest of the wording (the `distinct`/`group by`
  suggestion) is not asserted, so it can be reworded without breaking tests —
  but `docs/materialized-views.md` quotes it, so keep the two in sync if changed.

## Docs

`docs/materialized-views.md` updated:
- §"Primary key inference (and the all-columns fallback)" — replaced the
  "fails loudly with `UNIQUE constraint failed`" bullet with the resolved
  "a materialized view must be a set" contract (dynamic detection, distinct
  keyless bodies still work, create-vs-refresh timing, no de-dup / no synthetic
  identity).
- §`REFRESH` `replaceBaseLayer` parenthetical — notes the caller-supplied
  "must be a set" diagnostic.
- Incremental "Keyless / bag bodies" limitation — updated from the raw
  `UNIQUE constraint failed` to the shipped diagnostic.
- Roadmap "Bag-body contract" entry — marked **delivered** with a back-link to
  the PK-inference section; dropped the `materialized-view-bag-body-duplicates`
  TODO pointer. No stale slug references remain in `docs/`.
