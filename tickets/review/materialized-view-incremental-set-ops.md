description: Review the set-operation `on-commit-incremental` MV support. Set-op bodies (`union`/`intersect`/`except`/`union all`) are now ACCEPTED at create and classified whole-MV `'global'`, so any source mutation triggers a full `rebuildBacking` at COMMIT (correctness-first whole-MV recompute — the proven manual-refresh path). The create-time set-op rejections (build-time gate + `compile()` throw) were removed. True count-based delta evaluation stays deferred to `materialized-view-incremental-set-ops-delta` (already in backlog).
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/planner/building/materialized-view.ts, packages/quereus/test/logic/52-materialized-views-incremental.sqllogic, docs/materialized-views.md
----

## What landed

This is the **same delivery shape** as the landed
`materialized-view-incremental-recursive-cte` work: a body with no bounded
per-binding residual is classified whole-MV `'global'`, and any source mutation
re-derives the entire body at COMMIT via `rebuildBacking` (the same recompute
manual `refresh` runs). Always correct; not algorithmically incremental.

### Code changes

- **`planner/building/materialized-view.ts`** — **deleted** the build-time gate
  `rejectUnsupportedIncrementalBody` and its single call site. After the prior
  recursive-CTE ticket removed recursion from that function, the only remaining
  check was the bag-distinguishing set-op throw; removing that left the function a
  no-op. All surviving create-time rejections now live exclusively in `compile()`
  against the analyzed plan. Verified there were no other callers
  (`find_references`). `AST`/`QuereusError`/`StatusCode` imports remain used by
  other code in the file (module-name check, arity check) — lint clean.

- **`core/database-materialized-views.ts`** — added an
  `else if (containsNodeType(analyzed, PlanNodeType.SetOperation))` branch in
  `compile()`, placed **between** the recursive-CTE `if` and the `else if (agg)`.
  Ordering matters: a set-op body whose branches aggregate/join must classify
  `'global'`, not misroute into the aggregate / non-inner-join rejections. The
  branch routes every collected source ref to `{ kind: 'global' }` and sets
  `relationToBase` (verbatim copy of the recursive branch's loop). Also **removed**
  the now-dead `SetOperation` rejection that used to live in the row-preserving
  `else` branch, plus the stale `union all` comment above it, and refreshed the
  `compile()` header comment to say set-ops classify `'global'` (no longer
  "rejected").

- **`docs/materialized-views.md`** — added a set-operation bullet to *Eligibility*
  (accepted-but-global, parallel to the recursive-CTE bullet); dropped set-ops
  from the *Rejected up front* paragraph and documented the `union all` bag → "must
  be a set"/`diverged` behavior; updated the *roadmap → Incremental refresh* bullet
  to mark set-ops delivered (global-rebuild) and point the delta follow-up at
  `materialized-view-incremental-set-ops-delta`.

### Why `union all` was globalized too (slightly beyond the named scope)

In the pre-change code all four set ops errored at create: bag-distinguishing ones
in the build gate, `union all` via the op-agnostic `compile()`
`containsNodeType(SetOperation)` throw. Globalizing the whole family is the
minimal coherent move — a strict improvement for `union all` (rejected →
correct-but-global) that avoids a bizarre split where the "harder" ops work but
the "simpler" one errors. A genuine bag-additive per-binding `union all` fast path
is deferred to `materialized-view-incremental-set-ops-delta`.

## How to validate

- Build: `yarn workspace @quereus/quereus run build` — **passes**.
- Tests: `yarn workspace @quereus/quereus test` — **3793 passing, 9 pending**.
  Focused: `--grep "52-materialized-views-incremental"`.
- Lint: `yarn workspace @quereus/quereus lint` (single-quote globs on Windows) —
  **passes**.

## Test coverage (oracle = hand-computed set; §26-30 appended)

Each set-op section pairs an `on-commit-incremental` MV with a parallel `manual`
MV over the identical body where it adds signal (§26), and exercises insert /
update / delete on **both** branches' sources, hitting the multiplicity edge each
operator hinges on:

- **§26 `union` (distinct).** The key case: deleting `v=10` from the left branch
  while the right branch still contributes `10` — `10` **survives** (a per-binding
  delete would wrongly drop it; the global rebuild keeps it). Then deleting it from
  both removes it. Manual MV lags until `refresh`.
- **§27 `intersect`.** A row enters the intersection when it appears in both
  branches; a delete on one branch removes it from the intersection though it still
  exists in the other (the cross-branch dependency a residual can't model).
- **§28 `except`.** Right-branch **deletion adds** a row back to the result;
  right-branch insertion removes one; left-branch insert is a straight add.
- **§29 `union all` accepted-but-global + bag contract.** Duplicate-free over
  disjoint sources maintains at COMMIT (both branches). A bag-at-create (same value
  in both branches) → create-time fill raises `-- error: must be a set`. A
  late-bag (set-clean at create, bag after a source insert) → `-- error: diverged`
  at COMMIT, then `-- error: must be a set` on explicit refresh — mirrors the
  recursive §25 but non-recursive. (This case also indirectly proves the global
  **rebuild** path is the one firing — the bag is only hit by a from-scratch
  recompute.)
- **§30 nested set-op in a subquery.** `select v from (select v from a union
  select v from b) t` is still classified `'global'` — proves the gate is the
  plan-based `containsNodeType` walk, not AST-top-level-only.

Also updated the two existing sections that asserted the old rejection:
- **§7** now creates+drops a `union` incremental MV (smoke: create no longer
  rejects) and keeps the recursive empty-source guard.
- **§21** now creates+drops the `union all` MV (was `-- error: set-operation`).

## Known gaps / things to scrutinize

- **Not algorithmically incremental.** Every source mutation on a set-op MV does a
  full recompute. This is intentional (correctness-first), but a reviewer should
  confirm the design tradeoff is acceptable and that the docs are honest about it.
- **Tests are correctness-only.** They assert MV contents, not which maintenance
  path fired. Set-ops always take the `input.globalRelations.size > 0 →
  rebuildBacking` path (same mechanism as the tested recursive §23-25); §29's
  late-bag→diverged is the one place that path is indirectly pinned. If the
  reviewer wants a stronger guarantee, consider asserting via a white-box hook that
  a per-binding apply never runs for a set-op body.
- **Bag contract consistency.** Set-ops route through the create/refresh
  full-rebuild path, which **does** enforce "must be a set" — so they are
  consistent with the bag-body contract (unlike the per-binding path's silent
  late-bag dedup tracked in `materialized-view-incremental-bag-silent-dedup`). Worth
  a reviewer sanity-check that no set-op input can sneak onto a per-binding path.
- **Empty-source set-op bodies** (e.g. `values(1) union values(2)`) still reject
  via the size-0 guard before the set-op branch — not explicitly covered by a new
  test (the recursive §7 empty-source guard exercises the same guard). Low risk;
  flag if the reviewer wants an explicit set-op variant.
- **Edge: `diff`.** The ticket noted `diff` expands to nested `SetOperationNode`s
  and would be caught by the `containsNodeType` walk. Not separately tested — the
  §30 nested-subquery case covers the "not-top-level" property; a `diff`-specific
  test could be added if desired.
