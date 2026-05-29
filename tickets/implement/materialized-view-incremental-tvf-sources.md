description: Maintain `on-commit-incremental` materialized views whose body fans out a base row through a *lateral table-valued function* (e.g. `select t.id, je.value from base t, json_each(t.arr) je`) incrementally instead of full-rebuilding. The base table is already collected and bound `'row'` on its PK; the residual already re-invokes the lateral TVF for the changed row. The missing piece is a *bounded delete* for the fan-out: a single base-row change maps to MANY backing rows, which the per-binding `delete-key` (one exact PK per binding tuple) cannot express, so `computeDeleteKeyOrder` returns `null` and the MV falls back to full rebuild on every change. Add a parent-key **prefix delete** maintenance op, gated by the TVF's `relationalAdvertisement` (so the recomputed fan-out is provably a set on the backing PK). Where the advertisement is insufficient to bound the apply, classify `'global'` (full rebuild) — never a wrong result.
prereq:
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/schema/function.ts, packages/quereus/src/planner/nodes/table-function-call.ts, packages/quereus/src/planner/util/key-utils.ts, packages/quereus/test/logic/52-materialized-views-incremental.sqllogic, docs/materialized-views.md, docs/incremental-maintenance.md, docs/optimizer.md
----

## Background — what already works, what breaks

The incremental MV maintainer (`MaterializedViewManager.compile()` in
`database-materialized-views.ts`) does NOT use `extractBindings`' classification;
it synthesizes bindings from the analyzed plan (`collectTableRefs` → per-source
`'row'` on PK / `'group'` on group key). A lateral TVF body such as

```sql
create table base (id integer primary key, arr text);
create materialized view v with refresh = 'on-commit-incremental' as
  select t.id, je.value from base t, json_each(t.arr) je;   -- lateral: je.* correlates to t.arr
```

builds as an inner/cross `JoinNode` (`buildJoin` with `isLateral`, see
`planner/building/select.ts`) whose left is the `base` `TableReferenceNode` and
whose right is a `TableFunctionCallNode` correlated to `base`. So today:

- `collectTableRefs` finds **only `base`** (the TVF is not a `TableReferenceNode`)
  → `size === 1`, row-preserving path → `base` bound `'row'` on `[id]`.
- The residual (`injectKeyFilter` onto `base` keyed by `pk0=:id`) **already**
  re-invokes the lateral TVF for exactly the changed base row and produces that
  row's fan-out correctly.
- **The delete is the only thing that breaks.** The backing physical PK is the
  all-columns fallback `(id, value)` (see below for *why*), so `value` — a TVF
  output column with no `base` provenance — makes `computeDeleteKeyOrder` return
  `null`, and `apply()` short-circuits to `rebuildBacking` on *every* base
  change. Correct, but not incremental.

### Why `keysOf` can't help (the core research finding)

The natural backing PK is `(base.PK ∪ TVF-per-call-key)`. `keysOf(body)` does
**not** surface it: a lateral/cross `JoinNode` with no equi-pairs has
`combineJoinKeys` (`planner/util/key-utils.ts`) return `[]` — it only checks
whether each side's key *alone* survives (it doesn't, for a cross product) and
never forms the **product key** `(leftKey ∪ shiftedRightKey)`; full-product
set-ness is deferred to `RelationType.isSet`. So even when the TVF advertises a
per-call key (lifted into FDs by `TableFunctionCallNode.computePhysical`), the
join-key composition discards it and the MV backing PK falls back to all-columns.

Conclusion: `relationalAdvertisement` carries the *right fact* (per-call key /
`isSet`), but it must be consumed **directly in MV compile()**, not via
`keysOf`. (Teaching `combineJoinKeys` to emit keyed-cross-product keys is the
general fix but has optimizer-wide blast radius — filed separately as
`optimizer-keyed-cross-product-join-keys`; this ticket stays MV-local.)

## Design — parent-key prefix delete, advertisement-gated

A base-row change drives **delete-all-rows-for-this-base-row, then re-insert the
recomputed fan-out**. Correctness reduces to two provable facts:

1. **Prefix isolation (structural/provenance).** The backing physical PK must
   decompose into a *leading run* of columns that each resolve (via the existing
   attribute-provenance machinery — `collectProducingExprs` / `resolveSourceCol`)
   to a `base` PK column and together cover *all* of `base.PK`, followed by
   trailing columns supplied by the TVF output. Then "delete every backing row
   whose leading prefix = the changed base PK" selects exactly the rows derived
   from that base row and nothing else (no other base row shares the prefix,
   since base PK is unique). If the backing PK is not so decomposable (base-PK
   columns not leading, interleaved, or not fully covered) → `'global'` rebuild.

2. **Fan-out set-ness (advertisement).** The per-base-row `upsert` batch must be
   a set on the backing PK, i.e. the backing-PK *TVF portion* must be a
   **superkey of the TVF output relation**. Discharge from
   `TableFunctionCallNode.functionSchema.relationalAdvertisement`:
   - resolve `adv.keys` (via `resolveAdvertisement`, mapping `ColRef` → output
     attrs → backing-PK columns through provenance); if some advertised key is
     covered by the backing-PK TVF columns → sound; **or**
   - `adv.isSet === true` AND the backing-PK TVF columns cover *all* of the TVF's
     output columns (the all-columns key) → sound.
   - Otherwise (no advertised key, not `isSet`, or only a strict subset of TVF
     columns in the PK) → the upsert could silently collapse distinct fan-out
     rows → classify `'global'` (full rebuild). This is the "advertisement
     insufficient → global, never wrong" guarantee.

   Determinism is **not** required for delete correctness (the prefix delete
   removes whatever is physically stored; the residual recomputes fresh). A
   non-deterministic TVF MV is ill-defined under `manual` refresh too and is out
   of scope.

### New maintenance op + range delete

Extend `MaintenanceOp` (`vtab/memory/layer/manager.ts`):

```ts
export type MaintenanceOp =
  | { kind: 'delete-key'; key: BTreeKeyForPrimary }
  | { kind: 'delete-by-prefix'; prefix: SqlValue[]; prefixLength: number }   // NEW
  | { kind: 'upsert'; row: Row };
```

`applyMaintenance`'s switch gains a `'delete-by-prefix'` arm: seek the primary
btree to the lower bound of `prefix` and delete-while the leading `prefixLength`
PK columns equal `prefix` (respecting per-column `desc`/collation from
`backingPkDefinition`). Mirror the prefix-range early-termination already in
`scan-layer.ts` (lines ~97 / ~178) — same comparator, same "break when prefix no
longer matches". The op stays inside the existing synchronous, latched batch
(atomic from the event loop's perspective), and secondary indexes rebuild once at
the end exactly as today. Update the `MaintenanceOp` doc comment (which currently
says "Range deletes … are deferred — those MVs fall back to a full rebuild") to
describe the new arm.

### compile() changes

Add a detection step in the row-preserving branch (after the existing per-source
PK binding, before/within the residual loop). For the **single base source +
lateral TVF** shape (v1):

- Detect a `TableFunctionCallNode` in the plan whose operands reference the bound
  base source's attributes (lateral correlation). Helpers: walk for
  `TableFunctionCallNode`; collect operand `ColumnReferenceNode.attributeId`s and
  test membership in the base ref's attribute ids.
- Compute a **prefix-delete order** (new `computePrefixDeleteOrder`, sibling to
  `computeDeleteKeyOrder`): returns `{ baseKeyOrder: number[]; prefixLength }`
  when fact (1) holds (base PK = a leading prefix of the backing PK), else `null`.
- Run the advertisement gate (fact (2)). If both hold → record a *prefix-delete*
  residual variant; else leave `deleteKeyOrder = null` (existing rebuild
  fallback) — or, when the TVF is detected but unbounded, set the source binding
  to `'global'` so the gate is explicit and documented.

`ResidualArtifacts` grows an optional prefix-delete descriptor; `apply()` emits
`delete-by-prefix` (built from the binding tuple's base-PK values) instead of
`delete-key` when present, then upserts `runResidual` output as today. The
overlay-capture path (`applyMaintenanceAndCapture`) must handle the new op when
the MV is a cascade producer: a prefix delete touches an unbounded set of backing
PKs, so the simplest correct treatment is to mark the backing base
*globally changed* for this pass (`markBackingRebuilt`) rather than synthesizing
per-row overlay deltas — dependents then re-evaluate in full. (A finer per-row
capture is a later optimization; document the choice.)

### Explicitly deferred (→ rebuild or backlog, all always-correct)

- Multiple base sources each feeding lateral TVFs; a TVF whose operands reference
  >1 base source; nested/chained TVFs.
- Lateral *subquery* over base tables — its inner tables ARE visible
  `TableReferenceNode`s, so it already routes through the join-bodies path; no new
  work, but add a confirming test.
- TVFs that read tables *internally* (integrated TVFs, no correlated operands):
  the hidden dependency is not a `TableReferenceNode`, so it is neither tracked as
  a source nor bindable — out of scope (these never advertise their inputs).
- Store-module (`yarn test:store`) incremental maintenance: `applyMaintenance` is
  memory-manager-only, matching the existing incremental path. Out of scope.

## Tests — vs a full-rebuild oracle

Add a section to `test/logic/52-materialized-views-incremental.sqllogic` using a
lateral TVF with a known advertisement (`json_each`-style key on the element
key/index, or a test-registered TVF advertising `isSet`/`keys` — see
`test/planner/tvf-physical-properties.spec.ts` and
`test/logic/94-tvf-edge-cases.sqllogic` for advertisement examples). Each case
asserts the incremental result equals what `manual` refresh (full rebuild)
produces for the same mutation:

- **Insert** a base row → its whole fan-out appears in the MV.
- **Delete** a base row → its entire fan-out vanishes (the prefix delete removes
  *all* rows for that base PK, not just one).
- **Update** a base row's TVF-input column so the fan-out *changes arity* (old
  3 rows → new 5 rows, and 5 → 2): the prefix delete + re-upsert converges
  exactly (this is the case the old `delete-key` path provably could not do).
- **Advertisement-insufficient** TVF (no `keys`, not `isSet`, or only a subset of
  TVF cols in the PK): create still succeeds under `on-commit-incremental`, a
  source mutation maintains correctly **via full rebuild** (assert correctness;
  optionally a white-box probe that the prefix-delete path was not taken), and
  the result matches the oracle — i.e. no silent fan-out dedup.
- **Non-leading prefix** (projection orders a TVF column before the base PK so
  base PK is not a leading backing-PK prefix): falls back to rebuild, result
  correct.
- **Lateral subquery over a base table** (control): maintains via the existing
  join-bodies path, result correct.

## Docs

- `docs/materialized-views.md` § Incremental refresh — add lateral-TVF to the
  maintainable shapes, state the advertisement gate and the prefix-delete
  mechanism, and the global-fallback rule.
- `docs/incremental-maintenance.md` — document the `delete-by-prefix` op alongside
  `delete-key`/`upsert`.
- `docs/optimizer.md` — note that the TVF `relationalAdvertisement` (`keys`/
  `isSet`) is consumed by MV maintenance to bound the fan-out, and cross-ref the
  `optimizer-keyed-cross-product-join-keys` backlog item as the general path.

## TODO

### Phase 1 — maintenance op + range delete
- [ ] Add `delete-by-prefix` to `MaintenanceOp` and the `applyMaintenance` switch
      in `vtab/memory/layer/manager.ts`; implement the latched prefix-range delete
      over the primary btree (collation/desc-aware bounds, early termination).
- [ ] Update the `MaintenanceOp` doc comment (drop the "range deletes deferred"
      note).

### Phase 2 — compile() detection + gate
- [ ] Add lateral-TVF detection (operand-correlation test against the base ref).
- [ ] Add `computePrefixDeleteOrder` (base PK = leading prefix of backing PK).
- [ ] Add the advertisement gate consuming `relationalAdvertisement.keys`/`isSet`
      via `resolveAdvertisement`; insufficient ⇒ `'global'`/rebuild.
- [ ] Extend `ResidualArtifacts` with the prefix-delete descriptor; wire `apply()`
      to emit `delete-by-prefix` + upsert.
- [ ] Handle the new op in `applyMaintenanceAndCapture` (mark backing globally
      changed for cascade producers in v1; document).

### Phase 3 — tests + docs + validation
- [ ] Add the `52-...sqllogic` section (insert / delete / arity-change update /
      advertisement-insufficient / non-leading-prefix / lateral-subquery control),
      each asserted against the full-rebuild oracle.
- [ ] Update `docs/materialized-views.md`, `docs/incremental-maintenance.md`,
      `docs/optimizer.md`.
- [ ] `yarn workspace @quereus/quereus run lint` clean; `tsc --noEmit` clean;
      full `packages/quereus` suite green (stream with `tee`).
