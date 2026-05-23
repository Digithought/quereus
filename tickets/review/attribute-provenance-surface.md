description: Review the attribute-provenance surface: a derived `computeAttributeProvenance` pass + cached per-node `getAttributeIndex()`, the validator rewrite that consumes them (replacing the bogus "each attribute ID appears once" invariant with "originated once"), and the two named per-node-index consumer migrations.
files: packages/quereus/src/planner/analysis/attribute-provenance.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/validation/plan-validator.ts, packages/quereus/src/planner/nodes/bloom-join-node.ts, packages/quereus/src/planner/rules/access/rule-monotonic-range-access.ts, packages/quereus/test/planner/attribute-provenance.spec.ts, packages/quereus/test/planner/validation.spec.ts, packages/quereus/test/runtime/async-gather.spec.ts, packages/quereus/test/runtime/fanout-lookup-join.spec.ts, docs/optimizer.md, docs/architecture.md
----

## What changed

Replaced the validator's `validatePhysicalTree` "each attribute ID appears at most once in the whole tree" invariant — which was never the real invariant and false-positived on every attribute-preserving parent — with a derived **attribute-provenance surface**.

### New: `computeAttributeProvenance(root)` — `planner/analysis/attribute-provenance.ts`
One post-order walk returning `Map<attrId, { originNode, path }>`. An ID is *originated* at the deepest relational node that outputs it and whose direct relational children do **not**; ancestors that re-publish it are *forwarding*. Throws `QuereusError(INTERNAL)` on (a) two **distinct** nodes originating the same ID, or (b) one node listing the same ID twice. Forwarding never throws. Dedupes by node identity, so a shared subtree instance (DAG) is not mistaken for a collision.

### New: `PlanNode.getAttributeIndex(): ReadonlyMap<number, number>` — `plan-node.ts`
Cached per instance (lazy field). Maps `attrId → index in getAttributes()`. Cache rebuilds automatically because `withChildren` mints a fresh instance. Declared on the `RelationalPlanNode` interface; default impl on the `PlanNode` base (uses the optional `getAttributes?()`).

### Validator rewrite — `plan-validator.ts`
- Calls `computeAttributeProvenance(root)` once at entry **when `validateAttributes` is on** (it both detects duplicate origins and yields the complete `attrId → origin` map, order-free).
- Dropped the per-node duplicate-registration loop (`registerAttribute`/`attributeIds` set/`attributeLocations`) — kept all per-attribute **shape** checks (numeric id, non-empty name, valid `sourceRelation`) and ordering-bounds checks.
- `validateColumnReference` now resolves against `provenance.has(attrId)` (via `ValidationContext.hasAttribute`), preserving the prior **global-set** scoping semantics. Sibling-scope visibility is intentionally NOT tightened (out of scope, per the original ticket).

### Consumer migrations (Phase 4)
Migrated the two **explicitly-named** per-node index lookups to `getAttributeIndex()`:
- `bloom-join-node.ts` — 4 `findIndex(a => a.id === …)` sites in `getType()` + `computePhysical()`.
- `rule-monotonic-range-access.ts` — `findColIndexForAttr` (was a manual O(n) loop).

Both preserve the prior `-1`-on-miss contract (`.get(id) ?? -1`).

## Honesty bar — what was deliberately NOT migrated

Per the original ticket's scope decision, these were evaluated and **left in place** (the surface is available for a future sweep):

- **`constraint-extractor.ts` `attributeToTableMap` / `findTargetRelationKey`** — built from **caller-supplied `tableInfos`** (carrying `columnIndexMap`/`uniqueKeys`/`relationKey`/`fds` payload), often a *filtered* single-table subset, not a tree walk. Reconstructing the rich `TableInfo` from `originNode` would duplicate `createTableInfoFromNode` and ignore the caller's table filtering → awkward coupling. Left, documented here.
- **`rule-quickpick-enumeration.ts` `attrIdToRel`** — maps `attrId → join-local leaf index` (0..N within the enumerated subgraph), not a global origin node. Does not fall out of the provenance surface naturally. Left with this note.
- **Other `findIndex(a => a.id === …)` sites** — `merge-join-node.ts`, `aggregate-node.ts`, `sort.ts`, `window-node.ts`, `reference.ts`, `key-utils.ts`, several rules, and the runtime emitters (`emit/bloom-join.ts`, `emit/merge-join.ts`, `emit/asof-scan.ts`) — were **out of the named Phase-4 scope**. Some emitters operate on raw attribute arrays (no node in hand) and aren't trivially migratable. `createTableInfoFromNode` also still builds its own `columnIndexMap` by hand (it additionally builds the `{id,name}` list, so the gain is marginal). None of these were touched.

## Use cases for testing / validation

**Provenance utility** (`test/planner/attribute-provenance.spec.ts`, new): origin-map correctness; forwarded ID attributed to the origin not the forwarding parent; mixed projection (forwarded col-ref + minted computed col, with the dropped column still in-scope); origin collision (two distinct nodes) throws; within-node duplicate throws; shared-instance DAG does not throw/hang. Plus `getAttributeIndex`: position correctness, cache identity across calls, fresh index on a new `withChildren` instance.

**Validator** (`test/planner/validation.spec.ts`): renamed `attribute ID uniqueness` → `attribute provenance (origination vs forwarding)`. Now asserts a parent **forwarding** a child's IDs is accepted (was previously rejected — semantics flipped, this is the core fix); origin collision between two sibling leaves throws `/originated at two distinct nodes/`; within-node dup still throws `/Duplicate attribute ID/`. The DAG test now asserts **no throw** (shared instance originates once). New `attribute-preserving node families` block builds **real** `JoinNode` (inner/right/cross), `SetOperationNode`, `EagerPrefetchNode`, `AsyncGatherNode` over mock leaves and validates with **default options**.

**Workaround removal**: `async-gather.spec.ts` and `fanout-lookup-join.spec.ts` both dropped their `{ validateAttributes: false }` workarounds and pass with default validation.

## Verification done

- `yarn typecheck` (tsc --noEmit): clean.
- Full quereus suite (`node test-runner.mjs`): **3440 passing, 9 pending, 0 failing**.
- Targeted specs (provenance/validation/async-gather/fanout): 113 passing.
- `yarn workspace @quereus/quereus run lint`: exit 0, no findings.

## Suggested review focus / known gaps

- **Traversal-order subtlety**: confirm the rationale that pre-order inline origin-registration would break the in-scope check (a ColumnReference in an ancestor predicate is visited before its originating scan). The fix relies on provenance being a *complete* precomputed map, not built during the validate walk. Worth a sanity check that no path queries `hasAttribute` expecting traversal-order semantics.
- **DAG dedup semantics**: a genuine un-aliased self-join (same leaf instance on both sides of a `JoinNode`, producing `[id, id]`) is no longer flagged by this validator — the shared instance originates once and the Join forwards both. This matches "originated once" but is a behavior change vs the old check. Confirm this is acceptable (the original ticket framed shared instances as legitimate DAGs).
- **Scope of consumer migration** is narrower than a full sweep (see "what was NOT migrated"). Reviewer may decide whether `merge-join-node.ts` (same shape as the migrated `bloom-join-node.ts`) should be migrated now for consistency — it was left only because it wasn't named in Phase 4.
- The `getAttributeIndex` cache uses `if (!this._attributeIndexCache)`; an empty map is still truthy (it's an object), so a zero-attribute node correctly caches an empty map and never recomputes. Confirm no node mutates its attribute list in place after first `getAttributeIndex()` (PlanNodes are immutable, so this should hold).
