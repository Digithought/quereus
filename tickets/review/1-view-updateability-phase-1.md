description: Review the shipped slice of view updateability — write-through for single-source projection-and-filter views. Shipped via an AST-rewrite: a view-targeted INSERT/UPDATE/DELETE whose body classifies as a single base table under only projection/filter/passthrough operators is rewritten to target the base table and re-planned through the ordinary base-table builder, reusing all constraint/conflict/FK/mutation-context machinery and surfacing the base to getChangeScope()/Database.watch for free. Constant-FD defaults from equality selection predicates, base-column defaults, identity/rename lineage, OR-clause conflict pass-through, and structured rejection diagnostics. Phase-1b: per-statement mutation-context threads through the view boundary. The plan-node `updateLineage`/`AttributeDefault` PhysicalProperties substrate and the `ViewMutationNode` orchestrator (multi-source Phase-2 foundation) were deliberately NOT wired — see Known gaps. Design source: `docs/view-updateability.md`.
prereq:
files: packages/quereus/src/planner/building/view-mutation.ts, packages/quereus/src/planner/mutation/propagate.ts, packages/quereus/src/planner/mutation/mutation-diagnostic.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/planner/analysis/scalar-invertibility.ts, packages/quereus/src/planner/building/schema-resolution.ts, packages/quereus/src/planner/building/insert.ts, packages/quereus/src/planner/building/update.ts, packages/quereus/src/planner/building/delete.ts, packages/quereus/test/logic/93.1-view-error-paths.sqllogic, packages/quereus/test/logic/93.2-view-mutation-pending.sqllogic, packages/quereus/test/logic/93.3-view-mutation-or-clause.sqllogic, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/logic/change-scope.spec.ts, docs/view-updateability.md, docs/architecture.md
----

# Review — View updateability (Phase 1 + 1b, single-source projection-and-filter)

## What shipped

Write-through for **single-source projection-and-filter views**. When `insert` /
`update` / `delete` targets a view, the builder (`insert.ts` / `update.ts` /
`delete.ts`) detects it via `schemaManager.getView(...)` and delegates to
`planner/building/view-mutation.ts`, which:

1. Plans the view body and gates it with `classifyViewBody` (`planner/mutation/propagate.ts`):
   the relational spine must be pass-through operators (Project/Filter/Sort/Limit/
   Distinct/Alias/Retrieve) terminating at exactly **one** `TableReferenceNode`.
   Joins / aggregates / set-ops / windows / recursive CTEs / VALUES bodies are
   rejected with a structured reason.
2. Derives per-output-column lineage (`planner/analysis/update-lineage.ts` +
   `scalar-invertibility.ts`): identity/rename column refs → writable `base`
   columns; anything else → read-only `computed`.
3. Rewrites the statement to target the base table (column remap, selection-
   predicate conjoined into WHERE for update/delete, constant-FD defaults injected
   into INSERT values) and **re-invokes the same base-table builder**.

Because the rewritten plan targets the base table, all constraint / conflict /
FK / OLD-NEW / RETURNING / mutation-context machinery is reused verbatim, and
`getChangeScope()` / `Database.watch` see the base table with no view-specific
code.

### Implementation strategy (the big call to scrutinize)

This is an **AST-level rewrite**, NOT the plan-node architecture the ticket
prescribed (`updateLineage`/`AttributeDefault` threaded through
`PhysicalProperties.computePhysical`, a `propagate.ts` visitor emitting `BaseOp[]`,
and a `ViewMutationNode` orchestrator over reused `DmlExecutorNode`s). Rationale:
for the **single-source** case there is exactly one base op, so an orchestrator
adds no behavior, and the rewrite reuses 100% of the base-table DML pipeline
(lowest-risk, zero duplication). The prescribed plan-node substrate is the
**multi-source Phase-2 foundation** — see Known gaps for why it was deferred and
what it would take to land. Reviewer should decide whether this divergence is
acceptable for Phase 1 or warrants a follow-up to build the substrate now.

## Diagnostics raised (`ViewMutationError`, `.mutationDiagnostic.reason`)

`no-inverse` (computed column written, names the column), `predicate-contradiction`
(insert literal contradicts an equality selection constant), `recursive-cte`,
`unsupported-join` / `-aggregate` / `-set-op` / `-window`, `no-base-lineage`
(VALUES body / no base table), `nested-view` (body sources another view),
`unsupported-source` (INSERT needs filter-constant defaults but source isn't VALUES),
`returning-through-view`.

## Validation performed

- `yarn workspace @quereus/quereus run build` — clean.
- Full quereus suite: **3753 passing, 0 failing, 9 pending** (`node test-runner.mjs`).
- `eslint` on all new/changed files — clean.
- NOT run: full-monorepo root `yarn test` (changes are entirely within the
  quereus package and purely additive to its API; left as a CI/reviewer step).

## Test coverage / acceptance use cases

- `93.1` §2 flipped reject→pass (only §2 changed; verified by diff — §1/§3/§4 byte-identical).
- `93.4-view-mutation.sqllogic` (working): GreenMen (constant-FD default via `select *`),
  AdultsBare (constant-FD default for a projected-away column), base-column default
  survives projection, rename projection, filter pass-through delete + update
  (selection predicate conjoined → invisible rows not matched), Phase-1b
  per-statement context stamped across multi-row insert through the view.
- `93.2-view-mutation-pending.sqllogic` (rejections): computed-lineage `no-inverse`
  (insert + update), aggregate body, union body, join body, VALUES body,
  predicate-contradiction, RETURNING-through-view.
- `93.3-view-mutation-or-clause.sqllogic`: OR IGNORE / REPLACE / FAIL / ABORT /
  ROLLBACK against a projection-filter view with PK-conflict violations.
- `change-scope.spec.ts`: a read through a view reports the BASE table (not the
  view); a view-mediated update has the same change scope as the equivalent base
  update; a base-table watcher fires on a view-mediated insert (GreenMen/Bob).

## Known gaps / shortcuts taken (review these adversarially)

1. **Plan-node lineage substrate NOT wired.** `updateLineage` / `AttributeDefault`
   on `PhysicalProperties` and their `computePhysical` threading on
   TableReference/Project/Filter are not implemented. Reason: not needed for the
   single-source AST rewrite, and adding Map-valued fields to `PhysicalProperties`
   is unsafe today — `explain.ts` does `safeJsonStringify(node.physical)` and
   `safeJsonStringify` does not handle `Map` (serializes to `{}`; a plain-object
   form holding plan-node refs would be circular/huge), and golden-plan snapshots
   would churn. Prerequisites to land it: teach `safeJsonStringify` to render Maps
   as a summary, regenerate golden plans, then thread the fields. The shipped
   lineage model lives in `update-lineage.ts` instead. **This is the main Phase-2
   foundation the ticket bundled — confirm the deferral is acceptable or spawn a
   plan ticket.**
2. **`ViewMutationNode` + `runtime/emit/view-mutation.ts` NOT created.** No
   orchestrator; single-source needs none. Required for Phase-2 multi-source
   fan-out (sequencing base ops, conflict composition across ops, FK ordering,
   RETURNING capture).
3. **Nested view / non-recursive CTE bodies rejected** (`nested-view`). The doc
   says these should be transparently mutable via inline-and-propagate; the
   AST-from-`selectAst` rewrite can't see an inner view's filters, so it rejects
   rather than silently dropping them. Needs the plan-tree propagation pass.
4. **`no-default` diagnostic deferred.** A missing NOT-NULL base column with no
   default still rejects the insert, but via the normal runtime NOT-NULL
   constraint error, not a plan-time `no-default` diagnostic naming the column.
5. **INSERT filter-constant defaults require a VALUES source.** A SELECT-sourced
   insert into a view that needs selection-predicate defaults raises
   `unsupported-source`. Pure projection/rename SELECT sources (no constants to
   inject) work.
6. **Phase-1b per-row generator seed not testable as written** — there is no
   `next_id()`/sequence default function in the engine. Per-row cadence rides the
   base table's per-row column-default evaluation; per-statement context threading
   is shipped + tested (`93.4`).
7. **Tag override surface (`quereus.update.*`) not implemented** (Phase 2+).
8. **`getChangeScope()` on no-RETURNING DML returns empty watches** by existing
   design (`isDmlWithoutReturning`) — not view-specific; the write side is covered
   by `Database.watch`. The "getChangeScope reports base row binding" line in the
   original ticket conflicts with that existing design; covered instead via the
   read-path + parity tests.

## Reviewer focus

- The AST rewrite in `view-mutation.ts`: column remap (`transformExpr`),
  predicate-contradiction detection, constant-FD injection, and the
  recursion-into-base-builder for correctness on edge cases (multi-row VALUES,
  explicit vs implicit column lists, generated base columns under `select *`,
  schema-qualified view names, `with context` pass-through).
- The `classifyViewBody` allowlist — are any updateable shapes wrongly rejected,
  or any non-decomposable shapes wrongly accepted?
- Whether the substrate deferral (#1, #2) should be pulled forward now.
