description: Implement view updateability **Phase 1 + Phase 1b** per `docs/view-updateability.md` — single-source projection-and-filter mutability with Dataphor-style per-attribute defaults, plus the mutation-context substrate (per-row generators, shared-key threading) that Phases 2/4 are gated on. Adds `updateLineage` / `attributeDefaults` to relational plan nodes (mirroring how `fds` thread through `computePhysical`), a propagation dispatcher that is the dual of `extractBindings`, view-aware DML target resolution, a `ViewMutationNode` orchestrator that reuses `DmlExecutorNode` per base op, conflict-resolution under fan-out, and `ChangeScope` expansion for view-mediated writes. Flips `93.1 § 2` from reject-to-pass for the projection-filter case. Substrate for the lens layer and write-through-materialized-view.
prereq:
files: packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/analysis/binding-extractor.ts, packages/quereus/src/planner/analysis/change-scope.ts, packages/quereus/src/planner/analysis/predicate-normalizer.ts, packages/quereus/src/planner/analysis/attribute-provenance.ts, packages/quereus/src/planner/nodes/project-node.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/nodes/table-reference-node.ts, packages/quereus/src/planner/nodes/dml-executor-node.ts, packages/quereus/src/planner/building/insert.ts, packages/quereus/src/planner/building/update.ts, packages/quereus/src/planner/building/delete.ts, packages/quereus/src/planner/building/table.ts, packages/quereus/src/planner/building/schema-resolution.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/schema/view.ts, packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/test/logic/93.1-view-error-paths.sqllogic, docs/view-updateability.md, docs/architecture.md
effort: xhigh
----

# View updateability — Phase 1 + Phase 1b

Implements the narrowest useful slice of `docs/view-updateability.md`: write-through a **single-source projection-and-filter** view, with the per-attribute default machinery and mutation-context substrate that later phases stand on. The full design (decided, extensive) is the source of truth for *intent*; this ticket + the code is the source of truth for *what ships*. Read `docs/view-updateability.md` end-to-end before starting — the per-operator rules, diagnostics union, and worked examples (GreenMen / AdultsBare / `u_core`+`u_contact`) are the acceptance spec.

## Why 1 + 1b together (not 1 alone)

Phases 2 (joins) and 4 (outer joins) are gated on the per-row mutation-context substrate (1b) — the doc's `Ada/Lin / next_rid()` shared-surrogate example fails without per-row context. Shipping projection-and-filter (1) without 1b commits the codebase to a default-recovery chain that has to be re-plumbed once context lands. Bundling them keeps the default chain correct on first landing.

## Audited code reality (May 2026 — confirmed against HEAD)

- **No `updateLineage` / `attributeDefaults` anywhere.** `RelationalPlanNode` (`plan-node.ts:641`) has only `getType` / `getAttributes` / `getAttributeIndex`. Physical facts (`fds`, `equivClasses`, `constantBindings`, `domainConstraints`) thread via each node's `computePhysical(childrenPhysical): Partial<PhysicalProperties>` — see `filter.ts:57`, `retrieve-node.ts:67`, `fanout-lookup-join-node.ts:260`. The FD helper library is `planner/util/fd-utils.ts` (`extractEqualityFds`, `computeClosure`, `mergeEquivClasses`, `MAX_FDS_PER_NODE`).
- **No propagation pass / `propagate.ts` / `propagateMutation`.** `planner/mutation/` does not exist.
- **DML against a view errors at resolution.** `buildInsertStmt` (`insert.ts:380`), `buildUpdateStmt`, `buildDeleteStmt` all call `buildTableReference(...)` (`building/table.ts:28`), which calls `resolveTableSchema` — **note: that function lives in `building/schema-resolution.ts`, not `table.ts`** (the plan ticket mislabeled it). It searches `findTable()` and errors "not found" on view names. `test/logic/93.1-view-error-paths.sqllogic` lines 23–41 (§ 2) asserts this for insert/update/delete.
- **`schemaManager.getView(schemaName, viewName): ViewSchema | undefined`** already exists (`schema/manager.ts:462`). This is the hook for view-aware target resolution.
- **Defaults are a base-column lookup today.** `insert.ts:124` reads `tableColumn.defaultValue` off the resolved `TableSchema`. No per-attribute default; defaults do not survive projection except via that write-time base lookup.
- **`extractBindings(plan): { perRelation: Map<string, BindingMode> }`** exists (`binding-extractor.ts`), consumed by `change-scope.ts:208`. The propagation pass is its **dual** — same FD/EC/predicate-normalizer pipeline, reverse direction. **Do not fork the analysis.**
- **`getChangeScope()`** (`change-scope.ts`) is FD-aware and propagates FROM-position DML targets but has no view-mediated-write concept (the case couldn't exist).
- **`DmlExecutorNode` constructor** (confirmed via `insert.ts:609`, `update.ts:333`): `(scope, source, tableReference, operation: 'insert'|'update'|'delete', onConflict?, mutationContextValues?, contextAttributes?, contextDescriptor?, upsertClausePlans?)`. OLD/NEW row descriptors are built by the builders and consumed by `ReturningNode` (`insert.ts:481+`, `update.ts:257+`). Reuse this node verbatim per base op — do **not** reimplement conflict/constraint plumbing.
- **`attribute-provenance.ts`** is the shipped attribute-id surface to reuse for `AttributeId`.

This audit supersedes `docs/architecture.md`'s "Predicate-Driven View Updateability" entry (which describes intent, not shipped code). Flip that entry to "Phase 1 shipped" when this lands.

## Design decisions already made (do not re-litigate)

- **`updateLineage` / `attributeDefaults` thread through `computePhysical`** alongside `fds` — add them to `PhysicalProperties` (the existing threading vehicle) rather than as bare interface fields, so the existing physical-properties propagation machinery carries them with zero new plumbing. The dedicated `update-lineage.ts` module owns the per-operator rule functions that `computePhysical` calls.
- **Orchestrator = `ViewMutationNode` wrapping reused `DmlExecutorNode`s**, not an in-emitter loop. Rationale: `DmlExecutorNode` already owns per-row constraint checks, OLD/NEW descriptors, `UpsertClausePlan`, and conflict resolution. A wrapper keeps it DRY and keeps conflict composition in one path.
- **RETURNING via captured per-op results**, not view-body re-evaluation. The orchestrator collects each base op's OLD/NEW descriptors and the RETURNING projection assembles view-level rows. Re-eval would be O(view-body) per statement; capture is one pass. (Phase 6, but design the capture hooks now.)
- **Default recovery is attribute-centric** (Dataphor-style). Base-column `DEFAULT`, constant-FD predicate bindings, and `default_for` tags are three *sources* of one `AttributeDefault` record, consulted in source-priority order: `constant-fd` > `default-for-tag` > `base-column`. EC propagation and FD reconstruction stay **after** defaulting (they're inference, not fallback).

## Type surface (from the plan ticket — pin these in `plan-node.ts`)

```ts
type UpdateSite =
  | { kind: 'base'; baseTable: TableSchemaRef; baseColumn: number; inverse?: ScalarPlanNode }
  | { kind: 'computed'; originatingExpression: ScalarPlanNode }
  | { kind: 'null-extended'; underlying: UpdateSite };

interface AttributeDefault {
  expression: ScalarPlanNode;
  cadence: 'literal' | 'per-statement' | 'per-row';
  source:
    | { kind: 'base-column'; baseTable: TableSchemaRef; baseColumn: number }
    | { kind: 'constant-fd'; predicate: ScalarPlanNode }
    | { kind: 'default-for-tag'; viewName: string };
}

// threaded through PhysicalProperties (mirrors fds / equivClasses):
//   readonly updateLineage?: ReadonlyMap<AttributeId, UpdateSite>;
//   readonly attributeDefaults?: ReadonlyMap<AttributeId, AttributeDefault>;
```

## Default-recovery chain (revised, attribute-centric)

1. The insert's value list (after applying the inverse of any scalar transform in the projection).
2. For each missing column, walk the `AttributeDefault` chain on its attribute id in source-priority order: (i) `constant-fd`, (ii) `default-for-tag`, (iii) `base-column`.
3. EC propagation — a column in an EC with a supplied member takes the EC representative's value.
4. FD reconstruction — a column functionally determined by supplied columns is reconstructed symbolically.
5. Nullable columns → `null`.
6. Otherwise → `no-default` diagnostic naming the column and the FD surface consulted.

## Conflict resolution under fan-out (`ViewMutationNode` policy)

`DmlExecutorNode` already implements per-op semantics on one table; the orchestrator's only job is sequencing + stop/continue policy:

| Clause | Under fan-out |
|---|---|
| `OR IGNORE` | Per-base-op IGNORE; violating op drops its row, siblings continue; statement succeeds even with zero-row ops. |
| `OR REPLACE` | Per-base-op REPLACE, independent per table; NOT-NULL conflict without a default falls through to ABORT *that op*. |
| `OR FAIL` | Abort statement at first violation; already-succeeded prior ops remain. |
| `OR ABORT` (default) | Abort statement at first violation; undo prior ops in the same statement. |
| `OR ROLLBACK` | Abort the enclosing transaction unconditionally. |

## Diagnostics raised in this ticket (Phase 1 / 1b rows of the doc's union)

- `no-inverse` — non-invertible scalar on an update path (Project). Name the obstructing column.
- `no-default` — insert with a missing NOT-NULL column after the recovery chain (Project).
- `predicate-contradiction` — insert violates the view's selection at plan time (Filter).
- `recursive-cte` — recursive CTE as mutation target (rejection only; non-recursive CTE mutability is Phase 7).
- `tag-target-not-found` — tag with unknown branch/table (tag parsing + per-operator at consumption).

Each diagnostic includes a copy-pasteable `with tags ("quereus.update.default_for.col" = ...)` suggestion where one applies.

## Invertibility classifier scope

`planner/analysis/scalar-invertibility.ts` (new). **Phase 1: identity + column-rename only.** Phase 1b extends to `cast`-style wrappers, `coalesce(x, default)` on the FD-provable-non-null path, and other declarable `passthrough`/`inverse` profiles per the doc's `InvertibilityProfile` table. Non-invertible expressions → `computed` lineage; attribute defaults pass through only on the invertible path.

## Mutation-context substrate (1b)

- Per-row generator cadence (sequences, surrogate allocators, per-row `now_ms()`).
- Shared-surrogate threading across an n-way decomposition (`u_core` + `u_contact` with `next_rid()` per row, threaded through the join EC into both base inserts — though n-way joins themselves are Phase 2; 1b lands the *threading mechanism* and single-base per-row cadence).
- **Reuse the existing Sequential ID Generation infra** (`docs/architecture.md` § Sequential ID Generation). Per-statement cadence likely already exists there — verify and reuse rather than building new.

---

## TODO

### Phase 1 — single-source projection-and-filter (MVP)

- [ ] Add `updateLineage?: ReadonlyMap<AttributeId, UpdateSite>` and `attributeDefaults?: ReadonlyMap<AttributeId, AttributeDefault>` to `PhysicalProperties` in `plan-node.ts`; define `UpdateSite` and `AttributeDefault` types there. Reuse `AttributeId` from `attribute-provenance.ts`.
- [ ] New `planner/analysis/update-lineage.ts` — per-operator lineage + default-inheritance rule functions, invoked from each node's `computePhysical`. Reuses the FD walk from `fd-utils.ts`; **does not fork** `binding-extractor.ts`.
- [ ] New `planner/analysis/scalar-invertibility.ts` — classify scalar expressions per the doc's `InvertibilityProfile`. **Phase 1: identity + column-rename only.**
- [ ] `TableReferenceNode.computePhysical` (`table-reference-node.ts`): originate `base`-lineage (identity inverse, `baseColumn = column index`) for every attribute; originate an `AttributeDefault(source: base-column)` for every column with a base `defaultValue`, cadence inferred from determinism (`literal` for constants, `per-statement` for `now()`-class, `per-row` for sequences/surrogate allocators).
- [ ] `ProjectNode` (`project-node.ts`): invertible (identity/rename in P1) expressions preserve `base` lineage with inverse recorded; non-invertible → `computed`. Attribute defaults pass through on the invertible path; projecting a column **away** does **not** delete its default (still reachable via attribute id). Add `propagateMutation(childRelations, op)`.
- [ ] `FilterNode` (`filter.ts`): pass-through lineage + defaults; the filter predicate contributes constant-FD `AttributeDefault` synthetic entries (`source: constant-fd`) — reuse `extractEqualityFds` from `fd-utils.ts`. Add `propagateMutation`. The filter is part of the row-identifying predicate for delete/update, **not** a post-hoc constraint.
- [ ] New `planner/mutation/propagate.ts` — `propagateMutation(target, op): BaseOp[]`. Visitor over the relation tree; non-`TableReferenceNode` invokes the per-operator method; terminates at `TableReferenceNode` materializing a `BaseOp`. Raise `recursive-cte` for recursive-CTE targets.
- [ ] View-aware target resolution: add `resolveMutationTarget` (extend `resolveTableSchema` in `building/schema-resolution.ts`, or add alongside) returning a discriminated `TableSchema | ViewSchema`. In `insert.ts` / `update.ts` / `delete.ts`, if the target resolves via `schemaManager.getView()`, plan the view body, run propagation, and build a `ViewMutationNode` instead of erroring.
- [ ] New `planner/nodes/view-mutation-node.ts` — orchestrator plan node carrying the ordered per-base `DmlExecutorNode` list, FK ordering (parent-before-child where provable), RETURNING-capture wiring, and conflict-resolution policy.
- [ ] New `runtime/emit/view-mutation.ts` — instruction emitter sequencing base-op execution under the `OR` policy, collecting RETURNING rows, ensuring transaction-frame atomicity.
- [ ] Plumb conflict resolution under fan-out (the `OR` table above) through `ViewMutationNode`.
- [ ] Expand `Statement.getChangeScope()` (`change-scope.ts`) to surface view-mediated base writes: union of the view's reachable base tables with per-base `row`/`group`/`global` bindings derived from the propagation pass's row-identifying predicate (same FD analysis `extractBindings` runs forward). Verify `Database.watch` against a base sees view-mediated writes with no new watcher code.

### Phase 1b — mutation-context substrate

- [ ] Per-row generator cadence (sequences, surrogate allocators, per-row `now_ms()`); per-statement cadence verified/reused from Sequential ID Generation infra.
- [ ] Shared-surrogate threading mechanism through the mutation-context envelope (single-base per-row in this ticket; n-way fan-out consumption is Phase 2).
- [ ] Extend `scalar-invertibility.ts` to `cast`-style wrappers, `coalesce(x, default)` on FD-provable-non-null, and declared `passthrough`/`inverse` profiles.

### Coordination (do early — load-bearing for the runner's cross-stage gate)

- [ ] Verify `tickets/plan/1-lens-foundation-and-default-mapper.md` `prereq:` points at this ticket's slug (`view-updateability-phase-1`) — the plan stage already repointed it from the defunct `view-updateability-implementation`; confirm it didn't drift.
- [ ] `materialized-view-core` is already in `complete/` (read-only at the user-write boundary). Write-through-MV is a **future** ticket gated on this one — nothing to edit now; note it in `docs/view-updateability.md` Status preamble.

### Docs

- [ ] Add a "Status" preamble to `docs/view-updateability.md` tracking which phases have landed (Phase 1 + 1b after this ticket).
- [ ] Flip `docs/architecture.md`'s "Predicate-Driven View Updateability" entry from intent to "Phase 1 shipped".

### Tests (TDD seeds — write before the impl where practical)

- [ ] `test/logic/93.1-view-error-paths.sqllogic` § 2 (lines 23–41): flip the three insert/update/delete assertions from `-- error:` to expected pass. **§ 1, § 3, § 4 stay byte-equal** — verify with a diff that only § 2 changed.
- [ ] New `test/logic/93.2-view-mutation-pending.sqllogic`: rejection cases Phase 1 does not handle — computed-lineage projections (`no-inverse`), set-op bodies, aggregate bodies, join bodies. Honest contract of what's shipped.
- [ ] New `test/logic/93.3-view-mutation-or-clause.sqllogic`: one section per `OR` mode (`IGNORE` / `REPLACE` / `FAIL` / `ABORT` / `ROLLBACK`) against a projection-filter view with at least one base-op-level constraint violation.
- [ ] Phase-1 functional seeds (in 93.x working-cases files):
  - **GreenMen**: `create view GreenMen as select * from Men where Color = 'green'; insert into GreenMen (Name) values ('Bob')` → writes `(Name='Bob', Color='green')` (constant-FD default).
  - **AdultsBare** (projected-away column w/ constant FD): `create view AdultsBare as select Name, Age from Adults where Country = 'US'; insert into AdultsBare values ('Bob', 30)` → writes `Country='US'`.
  - **Base-column default survives projection**: `create table u (id int primary key, name text default 'unknown'); create view v as select id from u; insert into v values (5)` → writes `id=5, name='unknown'`.
  - **Rename projection**: `create view V as select id as user_id, name as full_name from users; insert into V (user_id, full_name) values (1, 'Bob')` → `id=1, name='Bob'`.
  - **Computed-lineage rejection**: `create view V as select id, length(name) as name_len from users; insert into V (id, name_len) values (1, 5)` → `no-inverse` naming `name_len`.
  - **Predicate contradiction**: `create view V as select * from t where x = 1; insert into V (x) values (2)` → `predicate-contradiction`.
  - **Filter pass-through delete**: `create view ActiveUsers as select * from users where active = true; delete from ActiveUsers where id = 5` → base delete on `users where id = 5 and active = true`.
  - **`getChangeScope()` reports base, not view**: `prepare update v set col = 1 where pk = 5; getChangeScope()` → underlying base's `row` binding (planner/unit test, not sqllogic).
  - **`Database.watch` on base sees view-mediated write** (watcher on `Men` sees GreenMen-via-Bob insert).
- [ ] Phase-1b functional seeds:
  - **Per-row generated default**: `create table t (id int primary key default next_id(), v int); create view v_only as select v from t; insert into v_only values (10), (20)` → two distinct `id`s.
  - **Per-statement timestamp**: `... insert into v with context now=epoch_ms('now') ...` → same `now` across every base op of every row.
- [ ] Regression bedrock: constraint enforcement composes (NOT-NULL/CHECK violation on a base column during view-mediated insert raises the existing diagnostic); non-recursive CTE in a view body is updateable iff the inlined plan is.

### Validation

- [ ] `yarn workspace @quereus/quereus run build` then `yarn test 2>&1 | tee /tmp/vu-test.log; tail -n 100 /tmp/vu-test.log` (stream; never silent-redirect).
- [ ] Lint (single-quote globs on Windows).
- [ ] If any failure is plainly pre-existing/unrelated, write `tickets/.pre-existing-error.md` per the stage rules and finish the ticket — don't chase it here.

## Handoff honesty (for the reviewer)

Phases 2–7 are explicitly **out of scope** and rejected-with-diagnostic (captured in `93.2`). The orchestrator's FK-ordering is best-effort "parent-before-child where provable" — document any cases left as unordered. RETURNING-capture hooks are wired in Phase 1 but the full RETURNING-through-views projection is Phase 6; note what's stubbed vs complete. This is a starting point, not a finish line — flag every shortcut taken under time/budget pressure rather than papering over it.
