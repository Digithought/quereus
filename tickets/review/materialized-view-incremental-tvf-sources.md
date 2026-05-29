description: Maintain `on-commit-incremental` materialized views whose body fans a base row out through a *lateral table-valued function* (`base t cross join lateral json_each(t.arr) je`) incrementally instead of full-rebuilding. A single base-row change maps to MANY backing rows, which the per-binding exact `delete-key` cannot express; this adds a base-PK **prefix delete** maintenance op (`delete-by-prefix`), gated by the TVF's `relationalAdvertisement` so the recomputed fan-out is provably a set on the backing PK. Where the advertisement (or the PK shape) is insufficient, classify to a full rebuild — never a wrong result.
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/test/logic/52-materialized-views-incremental.sqllogic, packages/quereus/test/materialized-view-lateral-tvf.spec.ts, docs/materialized-views.md, docs/incremental-maintenance.md, docs/optimizer.md
----

## What landed

A lateral-TVF fan-out body now maintains **incrementally** via a bounded base-PK
prefix delete + re-insert, instead of falling back to a full rebuild on every
source change. Correctness rests on two compile-time facts; if either is
unprovable, the body keeps the always-correct full-rebuild fallback.

### Phase 1 — `delete-by-prefix` maintenance op (`vtab/memory/layer/manager.ts`)
- Extended `MaintenanceOp` with `{ kind: 'delete-by-prefix'; prefix; prefixLength }`
  and updated its doc comment (dropped the "range deletes deferred" note).
- New private `deleteByPrefix(prefix, prefixLength)`: seeks the primary btree to
  the prefix (the composite-key comparator's length-diff branch positions a
  shorter probe just before all full keys sharing it), forward-scans collecting
  rows whose leading `prefixLength` PK columns match (collation-aware per-column
  compare), and stops at the first post-run mismatch (contiguity). Matches are
  collected first, then deleted by key, so the scan never mutates the tree it
  walks. Mirrors `scanLayer`'s prefix-range early-termination. Runs inside the
  existing synchronous latched batch; secondary indexes rebuild once at the end.

### Phase 2 — compile() detection + gate (`core/database-materialized-views.ts`)
- `detectLateralTvf` — v1 shape only: exactly one `TableFunctionCallNode` whose
  operands correlate **only** to the single bound base source.
- `computePrefixDeleteOrder` (fact 1, prefix isolation) — backing PK must lead
  with a run of base-PK columns covering ALL of base PK, followed by ≥1
  TVF-supplied column. Leading prefix columns must be **ascending** (so the
  matching rows are a contiguous forward run); a desc leading column ⇒ `null` ⇒
  rebuild.
- `tvfBackingPortionIsSuperkey` (fact 2, fan-out set-ness) — consumes
  `relationalAdvertisement` directly (`keys` covered by the backing-PK TVF cols,
  OR `isSet` + all TVF cols present). Out-of-range advertised key indices are
  naturally rejected.
- `ResidualArtifacts` grows `prefixDelete: PrefixDeleteDescriptor | null`. When
  both facts hold, `compile()` records it (and `deleteKeyOrder` is naturally
  `null`); `apply()` emits `delete-by-prefix` (built from the binding tuple's
  base-PK values) + upserts. The rebuild gate is now
  `deleteKeyOrder === null && !prefixDelete`.
- `applyMaintenanceAndCapture`: a `delete-by-prefix` batch on a **cascade
  producer** marks the backing globally changed (dependents re-evaluate in full)
  rather than synthesizing per-row overlay deltas — the op touches an unbounded
  PK set the per-row capture can't enumerate.

### Prerequisite engine fix — `emit/ast-stringify.ts`
- `astToString` now emits `LATERAL` for lateral joins. **This was a hard
  blocker:** MV bodies round-trip through `astToString` (rebuild/refresh
  `collectBodyRows`, `deriveBackingShape`), and dropping `LATERAL` made the
  re-parsed body fail to resolve the correlation (`t.arr isn't a column`). The
  feature is impossible without it. Small, faithful change; applies to all
  lateral-join stringification, not just MVs.

## Use cases for testing / validation

**`test/logic/52-materialized-views-incremental.sqllogic` §32–36** (each asserted
against the hand-computed full-rebuild oracle):
- §32 incremental fan-out — create-time, INSERT (whole fan-out appears), DELETE
  (entire fan-out vanishes via prefix delete), arity-shrink update (3→2),
  arity-grow update (1→3, the case exact-delete provably couldn't do), manual
  refresh escape valve.
- §33 advertisement-insufficient (`select je.value` only) → full rebuild, correct,
  no silent dedup (distinct values keep the body a set).
- §34 non-leading prefix (TVF column projected before base PK) → full rebuild.
- §35 lateral **subquery** over a base table (control) → routes through the
  existing inner/cross-join path (no TVF node), maintains correctly.
- §36 composite base PK + lateral TVF → 2-column prefix delete (insert / delete /
  arity-shrink).

**`test/materialized-view-lateral-tvf.spec.ts`** (white-box + oracle):
- Fault-injection witness that the **incremental prefix-delete path actually
  runs**: under a residual+rebuild fault, the gate-passing MV diverges (it took
  the residual path) while the gate-failing MV does not (it rebuilt directly).
- Incremental result == parallel `manual` MV oracle across insert/delete/arity.
- `isSet` route of the gate via a custom test TVF advertising `isSet` only (no
  `keys`), projecting all TVF columns into the backing PK.

Validation run clean: `lint` ✓, `tsc --noEmit` ✓, full `packages/quereus` suite
**3796 passing / 9 pending / 0 failing**.

## Honest gaps — where to scrutinize / extend

- **`deleteByPrefix` seek with collated/desc leading columns.** Desc leading
  prefix columns are gated out at compile time (⇒ rebuild), so the runtime only
  sees ascending prefixes — but that gate is the *only* thing keeping the
  seek+forward-scan sound for desc. The per-column match test is collation-aware
  (`compareSqlValues` with the declared collation), but the *seek positioning*
  for a NOCASE/collated leading PK column is **not** directly covered by a test
  (all prefix tests use INTEGER base PKs). Worth a targeted test or a second look
  at the partial-array `find` semantics under collation.
- **Cascade producer + prefix-delete is untested.** The "mark globally changed"
  treatment is always-correct by construction (dependents rebuild), but no test
  has a dependent MV reading a lateral-TVF MV's backing table. Add one if you
  want the path exercised.
- **Advertisement is trusted.** The `keys`/`isSet` gate trusts the TVF's
  advertisement (a lying advertisement could cause silent fan-out dedup). This
  matches how the rest of the optimizer trusts advertisements (e.g. DISTINCT
  elision), but it is the soundness hinge — confirm the built-in TVF
  advertisements are honest and that this trust is acceptable.
- **`astToString` LATERAL change has the widest blast radius** of this diff
  (touches every lateral-join round-trip). Full suite (incl. asof-scan lateral
  tests) passes, but give the stringifier change an independent read.
- **Performance not benchmarked.** `deleteByPrefix` is O(log n + block) for the
  common ascending case (seek then scan the matching run); not measured.
- **Explicitly out of scope (rebuild or deferred, all always-correct):** multiple
  base sources each feeding TVFs; a TVF correlated to >1 source; nested/chained
  TVFs; non-correlated/constant-operand TVFs (not detected ⇒ rebuild); store
  module (`applyMaintenance` is memory-manager-only). The general optimizer fix
  that would make `keysOf` surface the keyed cross-product key (removing the need
  for MV-local advertisement consumption) is filed as the existing backlog item
  `optimizer-keyed-cross-product-join-keys`.

## Docs updated
- `docs/materialized-views.md` § Incremental refresh — lateral-TVF added to the
  maintainable shapes (prefix isolation + set-ness gate + global-fallback rule);
  Apply contract describes the prefix delete; cascade limitation notes the
  globally-changed treatment.
- `docs/incremental-maintenance.md` — `delete-by-prefix` documented alongside
  `delete-key`/`upsert`; the prefix-delete gate; the cascade capture treatment.
- `docs/optimizer.md` — TVF `relationalAdvertisement` (`keys`/`isSet`) is consumed
  directly by MV maintenance to bound the fan-out, with the `combineJoinKeys`
  rationale and cross-ref to `optimizer-keyed-cross-product-join-keys`.
