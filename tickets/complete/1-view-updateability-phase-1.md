description: View updateability Phase 1 + 1b — write-through for single-source projection-and-filter views via an AST-level rewrite that retargets view-mediated INSERT/UPDATE/DELETE to the base table and re-plans through the ordinary base-table builder, reusing all constraint/conflict/FK/mutation-context machinery and surfacing the base to getChangeScope()/Database.watch. Reviewed, two correctness bugs fixed inline (alias-qualifier leak, LIMIT/OFFSET/DISTINCT write-widening), dead code + stray binary removed, Phase-2 plan-node substrate deferral confirmed and captured as a backlog ticket.
files: packages/quereus/src/planner/building/view-mutation.ts, packages/quereus/src/planner/mutation/propagate.ts, packages/quereus/src/planner/mutation/mutation-diagnostic.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/planner/analysis/scalar-invertibility.ts, packages/quereus/src/planner/building/schema-resolution.ts, packages/quereus/src/planner/building/insert.ts, packages/quereus/src/planner/building/update.ts, packages/quereus/src/planner/building/delete.ts, packages/quereus/test/logic/93.1-view-error-paths.sqllogic, packages/quereus/test/logic/93.2-view-mutation-pending.sqllogic, packages/quereus/test/logic/93.3-view-mutation-or-clause.sqllogic, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/logic/change-scope.spec.ts, docs/view-updateability.md, docs/architecture.md
----

# Complete — View updateability (Phase 1 + 1b, single-source projection-and-filter)

## What shipped

Write-through for **single-source projection-and-filter views**. A view-targeted
`insert` / `update` / `delete` is detected in the builder (`insert.ts` /
`update.ts` / `delete.ts` via `schemaManager.getView`) and delegated to
`planner/building/view-mutation.ts`, which:

1. Plans the view body and gates it with `classifyViewBody` (`mutation/propagate.ts`):
   the relational spine must be pass-through operators terminating at exactly one
   `TableReferenceNode`; joins / aggregates / set-ops / windows / recursive CTEs /
   VALUES bodies are rejected with a structured reason.
2. Derives per-output-column lineage (`analysis/update-lineage.ts` +
   `scalar-invertibility.ts`): identity/rename column refs → writable `base`
   columns; everything else → read-only `computed`.
3. Rewrites the statement to target the base table (column remap, selection
   predicate conjoined into WHERE, constant-FD defaults injected into INSERT
   values) and re-invokes the same base-table builder — so all constraint /
   conflict / FK / OLD-NEW / RETURNING-rejection / mutation-context machinery is
   reused verbatim and `getChangeScope()` / `Database.watch` see the base table
   with no view-specific code.

The implementation strategy (AST rewrite rather than the prescribed plan-node
substrate) is sound for the single-source case and was accepted — see Review
finding 5.

## Review findings

Reviewed the full implement diff (commit `26a33308`) with fresh eyes across
correctness, SPP/DRY, modularity, resource cleanup, error handling, and type
safety, then ran lint + the full quereus suite. Disposition below.

### Major (correctness) — fixed inline

1. **Alias-qualified base columns in the view body leaked into the rewrite and
   failed to resolve.** A body like `select x.id as aid from t as x where x.active = 1`
   conjoined the raw predicate `x.active = 1` into the base statement, which threw
   `x.active isn't a column` against base table `t` (a confusing internal binding
   error, not a clean diagnostic). Fixed: `view-mutation.ts` now normalizes column
   references qualified by the body's alias or base-table name to unqualified form
   (`normalizeBaseRefs`) when threading the filter predicate and computed-column
   lineage into the single-source statement (subqueries are not descended into,
   preserving the documented Phase-1 limitation). Regression test added to `93.4`
   (`AliasView`: aliased update visible/invisible rows + delete).

2. **`LIMIT` / `OFFSET` / `DISTINCT` view bodies silently widened the write.**
   `classifyViewBody` tolerates `LimitOffset` / `Sort` / `Distinct` as pass-through
   so the walk can reach the base table, but the predicate-conjoin rewrite drops
   them — so `delete from <limit-2-view>` deleted **all** rows (verified: 5→0, not
   5→3), and a DISTINCT view has no 1:1 base-row lineage. Fixed: `analyzeView` now
   rejects `sel.limit` / `sel.offset` (`unsupported-limit`) and `sel.distinct`
   (`unsupported-distinct`) with structured diagnostics; two new reason codes added
   to `mutation-diagnostic.ts`; `propagate.ts` doc comment clarified that the walk
   tolerates these only to reach the base while the rewrite layer rejects them.
   Regression tests added to `93.2` (vlim delete+update, vdist delete). `Sort`
   without limit is left allowed — ordering does not affect which rows a mutation
   matches.

### Minor — fixed inline

3. **Dead code.** `resolveMutationTarget` / `MutationTarget` were added to
   `schema-resolution.ts` but never referenced (the three builders inline the
   `getView` check directly). Removed, along with the now-unused `ViewSchema`
   import.

4. **Stray binary artifact committed.** `vu-logic.log` (2948-byte test log) was
   committed at the repo root and is not gitignored. Removed via `git rm`.

### Major (deferral) — confirmed acceptable, captured as a ticket

5. **Plan-node substrate (`updateLineage` / `AttributeDefault` on
   `PhysicalProperties`, `propagate.ts` BaseOp visitor, `ViewMutationNode`
   orchestrator) was deliberately not wired.** Reviewed the rationale: for the
   single-source case the AST rewrite is complete and an orchestrator over one
   base op adds no behavior; the blocker (`safeJsonStringify` cannot serialize
   `Map`-valued physical fields, plus golden-plan churn) is real. **Deferral is
   acceptable for Phase 1.** The substrate is the prerequisite for Phase 2
   (multi-source, nested/CTE bodies, RETURNING-through-views) and the AST approach
   does not generalize, so the deferred work is now tracked in
   `tickets/backlog/view-mutation-plan-node-substrate.md` rather than left implicit.

### Checked, no action needed

- **`classifyViewBody` allowlist** — joins (all join node types), aggregates,
  set-ops, windows, recursive CTEs, and multi-table / zero-table (VALUES) bodies
  are correctly rejected with specific reasons; after fix 2 the accepted set is
  genuinely projection-and-filter (+ harmless Sort).
- **Column remap** — explicit vs implicit column lists, rename projection,
  `select *` generated-column filtering on INSERT, computed-column filtering in
  WHERE (substituted, not rejected), schema-qualified view names, `with context`
  pass-through: all exercised by `93.4` / probes.
- **Constant-FD defaults & predicate-contradiction** — equality-conjunct
  extraction, append-when-omitted, contradiction rejection on literal VALUES cells;
  non-literal (parameter) cells correctly skip plan-time contradiction (cannot be
  known at plan time — documented behavior).
- **OR-clause conflict pass-through** (`93.3`): IGNORE / REPLACE / FAIL / ABORT /
  ROLLBACK all route to the base op unchanged.
- **Change-scope / watch parity** (`change-scope.spec.ts`): read-through reports
  the base table; view-mediated update has identical change scope to the base
  update; base-table watcher fires on a view-mediated insert.
- **Re-entrancy** — the rewrite recurses into the base-table builder; the
  `nested-view` rejection and the fact that the rewritten target is a base table
  prevent infinite recursion.
- **Documented Phase-1 gaps** (`no-default` via runtime NOT-NULL instead of
  plan-time diagnostic; INSERT filter-constant defaults require a VALUES source;
  nested-view / RETURNING-through-view rejected; tag-override surface absent;
  no-RETURNING DML reports empty `getChangeScope` watches by existing design) —
  all honestly documented in the ticket and `docs/view-updateability.md`; not
  defects.

## Validation

- `yarn workspace @quereus/quereus run build` — clean.
- `eslint` on all changed source files — clean.
- Full quereus suite (`node test-runner.mjs`): **3753 passing, 0 failing, 9 pending**
  — unchanged from the implement baseline (new assertions land inside existing
  per-file `it` blocks). New cases: `93.4` alias update/delete; `93.2` LIMIT
  delete+update and DISTINCT delete rejections.
- NOT run: full-monorepo root `yarn test` and `yarn test:store` — changes are
  confined to the quereus package; left as a CI step.

## Follow-up tickets filed

- `tickets/backlog/view-mutation-plan-node-substrate.md` — the deferred Phase-2
  plan-node substrate (finding 5).

(Multi-source decomposition remains tracked by the pre-existing
`tickets/plan/lens-multi-source-decomposition.md` and
`coverage-prover-multi-source-bodies.md`; this ticket adds the general
view-mutation substrate those build on.)
