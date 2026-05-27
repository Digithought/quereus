description: Add keysOf()/isUnique() as the single uniqueness read surface reconciling RelationType.keys, PhysicalProperties.fds, and RelationType.isSet; migrate the audited FD/key consumers through it (closing the DISTINCT all-columns-key gap); add a fast-check key-soundness property harness; audit per-operator propagation (projection drop + at-most-one ⇒ isSet); update docs.
files: packages/quereus/src/common/datatype.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/nodes/distinct-node.ts, packages/quereus/src/planner/nodes/project-node.ts, packages/quereus/src/planner/nodes/join-utils.ts, packages/quereus/src/planner/rules/distinct/rule-distinct-elimination.ts, packages/quereus/src/planner/rules/aggregate/rule-groupby-fd-simplification.ts, packages/quereus/src/planner/rules/sort/rule-orderby-fd-pruning.ts, packages/quereus/src/planner/rules/join/rule-join-elimination.ts, packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts, packages/quereus/src/planner/rules/subquery/rule-semi-join-fk-trivial.ts, packages/quereus/test/property.spec.ts, docs/optimizer.md, docs/architecture.md
effort: xhigh
----

## Goal

Stop callers from caring which of the three surfaces a uniqueness fact lives on. Today:

- `RelationType.keys: ColRef[][]` — declared/logical superkeys (`[]` = ≤1 row).
- `PhysicalProperties.fds` — FDs; key `K` ⇒ `K → (all_cols \ K)`; `∅ → all_cols` = ≤1 row.
- `RelationType.isSet: boolean` — the all-columns key (no non-trivial FD encoding exists; `superkeyToFd` returns `undefined` for `K = all_cols`).

FD-consuming rules read `keys`/`fds` but **never `isSet`**, so the all-columns key a `select distinct x, y` proves is invisible to them. Two helpers reconcile all three; consumers migrate to them once and the `isSet`-vs-materialized-key representation can change later without touching consumers.

**Default for this ticket: keep `isSet` as-is.** Deliver the read surface and migrate consumers; defer any representation change. (See `docs/optimizer.md:1241` and `:1265` for the current "check all three" guidance the helpers will encapsulate.)

## Soundness vs completeness (the framing for the whole ticket)

- **Soundness** = never claim a key that does not hold. A correctness invariant — an over-claimed key makes DISTINCT/join elimination drop real rows. Must be 100%.
- **Completeness** = never miss a real key. NP-hard / data-dependent in general; best-effort only.

"100% accuracy" therefore means **100% soundness + best-effort completeness**. Over-capping enumeration costs completeness only, never soundness.

## Surface design

Add to `packages/quereus/src/planner/util/fd-utils.ts`:

```ts
interface KeyRel { getType(): RelationType; physical?: PhysicalProperties }

// Canonical minimal candidate keys (each a sorted readonly number[] of output
// column indices), normalized & deduped. Empty result ⟺ relation is a bag.
// Includes the all-columns key as fallback iff the relation is a set but no
// smaller key was found. Includes the empty key [] when ≤1-row is proven.
keysOf(rel: KeyRel): readonly (readonly number[])[];

// Is `cols` a superkey? Uses FD closure (an FD can prove a superkey not in the
// minimal key list), the declared keys, the ≤1-row fact, and the
// all-columns/set fact.
isUnique(cols: readonly number[], rel: KeyRel): boolean;
```

`keysOf` draws keys from, in this order (cheap → expensive):
1. **Declared `keys`** (`RelationType.keys`), mapped to column indices. The empty key `[]` (TableDee/≤1-row) is preserved as an empty entry — it subsumes every other key.
2. **`∅ → all_cols` FD** (`hasSingletonFd`) ⇒ emit the empty key `[]`.
3. **FD-derived keys** via `deriveKeysFromFds` (already exists, already bounded to FDs with `det.length < columnCount`).
4. **All-columns fallback**: if the result so far is empty AND the relation is a set (`getType().isSet === true`), emit the all-columns key `[0..columnCount-1]`.

Then normalize: drop any key that is a superset of another key already present (keep minimal keys); dedupe by sorted-set equality. The empty key, if present, is the unique minimal key.

**Enumeration bound (required, documented):** minimal-key derivation from a general FD set is the candidate-key enumeration problem (NP-hard in column count). `deriveKeysFromFds` already bounds work by iterating existing FDs (one seed per FD) rather than enumerating subsets — keep that. `keysOf` must **always** emit declared keys + the all-columns fallback regardless of FD-enumeration cost, and must not do exponential subset enumeration. Document this cap in the `keysOf` doc-comment: over-capping loses completeness only.

`isUnique(cols, rel)` returns true iff **any** of:
- `cols` (as a set) is a superset of some entry in `keysOf(rel)` (covers declared keys, ≤1-row empty key, FD-derived keys, and the all-columns/set key), **or**
- `isSuperkey(new Set(cols), rel.physical?.fds, columnCount)` — FD closure proves it even if not in the minimal list.

This is a pure read surface — no plan mutation, no new physical fields.

## Consumer migration

Route the audited callers through the new surface. Keep each rule's existing semantics; the only behavioral change is that `isSet` now participates.

### Closes the gap (primary wins)

- **`rule-distinct-elimination.ts`** — currently checks `sourceType.keys.length > 0`, `hasAnyKey`, `hasSingletonFd`; misses `isSet`. Replace with: eliminate the DISTINCT iff `keysOf(node.source).length > 0` (a non-empty key set ⟺ the source is already a set ⟺ DISTINCT is a no-op). This is the clean equivalence "≥1 unique key ⟺ set". This makes `select distinct x,y from (select distinct x,y …)` drop the outer DISTINCT.
- **`rule-groupby-fd-simplification.ts`** — today drops GROUP BY columns determined by other GROUP BY columns via `minimalCover` over `physical.fds` + ECs. Extend so an **all-output-column GROUP BY over a set source** collapses: when the candidate set covers all output columns and the source `isUnique(allCols)`, the cover can drop to a minimal key. Reuse `keysOf`/`isUnique` rather than only `minimalCover`. Preserve the existing picker-MIN rewrite and attribute-ID preservation.
- **`rule-orderby-fd-pruning.ts`** — today prunes trailing keys via `computeClosure`. Add: once the leading keys cover a full `keysOf` entry (or `isUnique(leadingCols)` holds), every remaining trailing key is a no-op tiebreaker and can be dropped. For an all-columns-key set source whose ORDER BY lists all columns, this prunes the redundant trailing keys.

### Preserve FK→PK semantics (no false at-most-one)

`rule-join-elimination.ts`, `rule-fanout-lookup-join.ts`, `rule-semi-join-fk-trivial.ts` prove "≤1 match" structurally via `checkFkPkAlignment` / `lookupCoveringFK` on table schemas — **not** via FDs/keys/`isSet`. The all-columns key does **not** make a single-column equi-join "at most one match"; that needs the matching predicate to cover a real superkey.

- Do **not** weaken these proofs. The FK→PK path stays primary and unchanged.
- Optional, narrow, lower-priority: additionally treat a lookup/PK side as ≤1-match when the equi-predicate's matched columns form a superkey of that side per `isUnique(matchedCols, side)` — i.e. the predicate covers a real key (including the all-columns key only when it covers *every* column of that side). Guard strictly: the matched-column set fed to `isUnique` must be exactly the side's equi columns, and must cover a `keysOf` entry. If this proves fiddly to wire soundly against the existing schema-based extraction, **defer it** — document the deferral inline and in the review handoff. The acceptance criterion is "no false at-most-one," which the untouched FK→PK path already satisfies.

`join-utils.ts:buildJoinRelationType` / `propagateJoinFds` already compute `isSet = inner/cross && left.isSet && right.isSet` and layer `preservedKeys`. No change needed beyond confirming the audit below.

## Per-operator propagation audit

Confirm each relational node's `getType()` / `computePhysical` emits only sound keys/FDs/`isSet` given its children. The harness (below) is the empirical backstop; this audit is the reasoned pass. Highest-risk:

- **Projection (`project-node.ts`)** — must drop any key/FD/`isSet`-derived claim referencing a projected-away column. Today `projectFds` / `projectKeys` / `deriveProjectionColumnMap` drop FDs/keys whose columns are projected away (verified: `projectFds` drops an FD if any determinant column is unmapped). **Risk:** `getType().isSet` is copied straight from `sourceType.isSet` (`project-node.ts:89`). That is **sound** — a projection of a set may produce duplicates (so projecting *down* could turn a set into a bag), so confirm: does Quereus projection drop columns? If a projection can output fewer/!-all source columns, `isSet: sourceType.isSet` is **unsound** (projecting away a key column can introduce duplicate rows). Audit this: if projection can be non-injective on the row, `isSet` must become `false` unless a surviving key still proves it. Add a focused test either way.
- **At-most-one-row ⇒ set consistency** — `keys` containing `[]` (TableDee, ≤1 row) and the `∅ → all_cols` FD both imply set-ness, but nodes don't reliably set `isSet=true` in that case. `keysOf`/`isUnique` already treat the empty key / singleton FD as a key, so consumers get the right answer through the surface. Confirm no node reports `isSet=false` while also carrying an empty key or `∅ → all_cols` FD (that's an internal inconsistency the harness should flag). Fix any node that does, or normalize inside `keysOf` (it already will, since the empty key wins).

Audit (read-only confirm, fix if unsound) the `isSet` writers/propagators surfaced by grep: `distinct-node`, `project-node`, `join-utils`, `set-operation-node` (`isSet: op !== 'unionAll'`), `recursive-cte-node`, `async-gather-node` (`every`), `stream-aggregate`/`hash-aggregate` (`true`), `window-node`, `values-node`, `single-row`, `cte`/`cte-reference`, `returning-node`, `table-function-call` (advertised), `best-access-plan.setIsSet`.

## Soundness validation harness

Add a `describe('Key Soundness', …)` block to `packages/quereus/test/property.spec.ts` (fast-check is already imported; follow the existing `fc.asyncProperty` + `db.eval` patterns there).

**Mechanism — two tiers, implement the robust tier first:**

*Tier 1 (required, robust): result-relation assertion over generated queries.*
- Generate small random tables (2–4 columns, a declared PK, ≤ ~12 rows) and seed them.
- Generate a query whose **top relational operator varies** so coverage spans the node zoo: bare scan, projection (incl. projecting away a key column), `DISTINCT`, `GROUP BY` (incl. all-columns), `ORDER BY`, `LIMIT`, `UNION`/`UNION ALL`/`INTERSECT`/`EXCEPT`, inner/left/cross joins, nested DISTINCT.
- `const root = db.getPlan(q)` → navigate the `BlockNode` to the top relational result node (mirror how `explain.ts` / `query_plan` walk children; the result node is the relational child of the block's output).
- Materialize rows via `db.eval(q)`.
- Assert: **(a)** for every key `K` in `keysOf(root)`, the projection of the materialized rows onto `K`'s column indices has all-distinct tuples (compare with `compareSqlValues`/`safeJsonStringify`-keyed Set); the empty key `[]` ⇒ ≤1 row. **(b)** if `root.getType().isSet === true`, the full rows have no duplicates.
- This catches over-claims at the result node for every generated shape.

*Tier 2 (best-effort, stronger per-node): isolated inner-node materialization.*
- Walk every relational node in the optimized tree. For each, attempt `emitPlanNode(node, new EmissionContext(db))` + `new Scheduler(root).run(ctx)` to materialize that node's rows in isolation (precedent: `scheduler_program` in `func/builtins/explain.ts`, and `Scheduler` in `runtime/scheduler.ts:47`).
- Wrap in try/catch: correlated/parameterized inner nodes won't emit standalone — **skip** those (don't fail the test on emission failure; this tier is a bonus). For nodes that materialize, run the same (a)/(b) assertions.
- If Tier 2 proves too flaky to stabilize within the ticket, ship Tier 1 only and file the per-node materialization as a follow-up `backlog/` ticket. Tier 1 must pass and must fail loudly on an injected over-claim (add a temporary sanity check during dev: e.g. force `isSet=true` on a known-bag node and confirm the harness reds).

Keep `numRuns` modest (~50) to stay within the test idle budget.

## Docs

- `docs/optimizer.md` "Functional Dependency Tracking" (line ~1190) and the `:1241`/`:1265` notes: document `keysOf`/`isUnique` as the single uniqueness read path, the all-columns/`isSet` reconciliation, the enumeration bound, and the soundness-vs-completeness distinction. Update the "check both `getType().isSet` and `keys.length > 0` and the FD set" guidance to "call `keysOf`/`isUnique`."
- `docs/architecture.md`: brief pointer to the unified surface in the FD/physical-properties discussion.

## Acceptance criteria

- `keysOf` and `isUnique` exist in `fd-utils.ts`, are documented (incl. the enumeration bound), and are the single uniqueness read path for the migrated consumers.
- `select distinct x, y` over `(select distinct x, y …)` eliminates the redundant outer DISTINCT; an all-output-column GROUP BY / ORDER BY over a set source is simplified / pruned. (Add focused logic or optimizer tests.)
- Join/fan-out/semi-join "at-most-one" proofs still require the matching predicate to cover a real superkey — no false at-most-one from the weak all-columns key.
- Tier-1 key-soundness harness passes and fails loudly on an over-claim.
- Projection drops keys/FDs/`isSet` over projected-away columns; at-most-one-row implies set consistently (through `keysOf` at minimum).
- `docs/optimizer.md` and `docs/architecture.md` reflect the unified surface and the soundness-vs-completeness distinction.
- `yarn build`, `yarn workspace @quereus/quereus test`, and lint pass.

## TODO

### Phase 1 — read surface
- Implement `keysOf` and `isUnique` in `fd-utils.ts` (reuse `deriveKeysFromFds`, `hasSingletonFd`, `isSuperkey`, `minimalCover`). Normalize to minimal keys; preserve empty key; all-columns fallback gated on `isSet`. Document the enumeration bound.
- Unit-test `keysOf`/`isUnique` directly: declared-keys-only, FD-derived, `∅ → all_cols`, set-with-no-smaller-key (all-columns fallback), bag (empty result), and a superkey provable by closure but absent from the minimal list.

### Phase 2 — consumer migration
- `rule-distinct-elimination`: eliminate iff `keysOf(source).length > 0`.
- `rule-groupby-fd-simplification`: collapse all-columns GROUP BY over a set source via `keysOf`/`isUnique`; keep picker-MIN + attribute-ID preservation.
- `rule-orderby-fd-pruning`: drop trailing keys once leading keys cover a `keysOf` entry / `isUnique(leadingCols)`.
- Join/fan-out/semi-join: leave FK→PK proof unchanged; optionally add the `isUnique`-covers-matched-cols recognition (strictly guarded) or defer with a documented note.

### Phase 3 — per-operator audit
- Confirm `project-node` drops keys/FDs over projected-away columns; resolve the `isSet: sourceType.isSet` soundness question (does projection drop row-distinguishing columns? if so, recompute `isSet`). Add a focused projection test.
- Confirm empty-key / `∅ → all_cols` ⇒ set consistency; normalize in `keysOf` and fix any node reporting `isSet=false` alongside an empty key.
- Read-only sweep of the `isSet` writers listed above; fix any unsound propagation.

### Phase 4 — harness + docs
- Add the Tier-1 (required) key-soundness property to `property.spec.ts`; attempt Tier-2 (best-effort), skip-on-emit-failure; if unstable, ship Tier-1 and file a backlog follow-up.
- Update `docs/optimizer.md` and `docs/architecture.md`.
- Run build + quereus tests + lint; stream output (`yarn … 2>&1 | tee /tmp/x.log; tail -n 80 /tmp/x.log`).
