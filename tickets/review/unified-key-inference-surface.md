description: Review the unified uniqueness read surface (keysOf/isUnique) and its consumer migration + per-operator soundness fixes. Verify soundness of the two over-claim fixes surfaced by the new harness (combineJoinKeys inner/cross; set-operation keys), the project-node isSet fix, and the migrated rules (distinct/orderby/groupby).
files: packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/util/key-utils.ts, packages/quereus/src/planner/nodes/project-node.ts, packages/quereus/src/planner/nodes/set-operation-node.ts, packages/quereus/src/planner/rules/distinct/rule-distinct-elimination.ts, packages/quereus/src/planner/rules/aggregate/rule-groupby-fd-simplification.ts, packages/quereus/src/planner/rules/sort/rule-orderby-fd-pruning.ts, packages/quereus/test/optimizer/keysof-isunique.spec.ts, packages/quereus/test/optimizer/keys-propagation.spec.ts, packages/quereus/test/optimizer/rule-orderby-fd-pruning.spec.ts, packages/quereus/test/optimizer/monotonic-limit-pushdown.spec.ts, packages/quereus/test/property.spec.ts, docs/optimizer.md, docs/architecture.md
----

## What was built

A single uniqueness read surface in `planner/util/fd-utils.ts` that reconciles the three places a uniqueness fact lives (`RelationType.keys`, `PhysicalProperties.fds`, `RelationType.isSet`), the migration of the audited consumers onto it, the soundness fixes the new harness surfaced, and docs.

### `keysOf` / `isUnique` (`fd-utils.ts`)
- `keysOf(rel)` → minimal, deduped candidate keys (sorted output-column-index arrays). Sources, cheap→expensive: declared `keys`; `∅ → all_cols` empty key; `deriveKeysFromFds`; **all-columns fallback gated on `isSet`** (only when nothing smaller found). `normalizeKeys` drops supersets; empty key subsumes all. `[]` result ⟺ bag.
- `isUnique(cols, rel)` → superset-of-a-`keysOf`-entry **or** a *proper-subset* FD-closure superkey. The proper-subset guard (`colSet.size < columnCount`) is the soundness crux: without it the all-columns set's trivially-self-covering closure would falsely report a bag unique. **Review this guard carefully.**
- `KeyRel` interface = `{ getType(); physical? }`; every `RelationalPlanNode` satisfies it.
- Enumeration bound documented in the `keysOf` doc-comment: no subset enumeration; over-cap loses completeness only.

### Consumer migration
- `rule-distinct-elimination`: now `keysOf(source).length > 0` (was `keys.length>0 || hasAnyKey || hasSingletonFd`). Strict superset of the old conditions plus the `isSet` path — this is what makes `select distinct x,y from (select distinct x,y …)` drop the outer DISTINCT.
- `rule-orderby-fd-pruning`: added **whole-tail pruning** — once the retained leading bare-column keys are `isUnique`, the rows are totally ordered and the entire remaining tail (bare **or** expression) is a no-op tiebreaker and drops. Gate relaxed to also run when only declared/`isSet` keys exist (no FDs).
- `rule-groupby-fd-simplification`: lifts source keys read via `keysOf(node.source)` into aggregate-output-space key FDs before `minimalCover`. Closes the gap where a source carries a declared key (or is only known a set via `isSet`) that `propagateAggregateFds` never materialized as a physical FD. Picker-MIN rewrite + attribute-ID preservation untouched.

### Soundness fixes the harness surfaced (the high-risk review targets)
Two **pre-existing** over-claims in `getType().keys`, both reachable through projection + the migrated DISTINCT elimination, both caught by the new Tier-1 harness, both fixed:
1. **`combineJoinKeys` (key-utils.ts) inner/cross** unioned both sides' keys unconditionally. Unsound: `ta CROSS JOIN tb` claimed `[a]` and `[d]` as keys though each repeats. Fixed to **coverage-gate** (mirror `analyzeJoinKeyCoverage`): left keys survive iff a right key is covered by equi-pairs, right keys iff a left key is covered. Used by `JoinNode` / `BloomJoinNode` / `MergeJoinNode`. *Reviewer: confirm the gating matches the physical-FD `preservedKeys` path and that no key=key join lost a legitimate key.*
2. **`set-operation-node.ts`** copied `leftType.keys` for all ops. Unsound for `union`/`unionAll` (right side reintroduces a left-key value; UNION ALL also duplicates). Fixed: `intersect`/`except` keep left keys (result ⊆ left rows); `union`/`unionAll` drop them (set-ness carried by `isSet`).

### Project `isSet` soundness (`project-node.ts`)
`getType().isSet` was inherited blindly from the source — **unsound** when a projection drops a row-distinguishing column (`select x from <set on (x,y)>` is a bag). Now: `isSet` true iff a declared source key survives the projection, **or** the source is a set and every source column survives (`map.size === sourceType.columns.length`). Conservative (loses completeness, never soundness): an injectively-derived-only key recognized solely in `computePhysical` is not counted by `getType().isSet`.

## Use cases / behaviors to validate

- `select distinct x, y from (select distinct x, y from t)` → outer DISTINCT eliminated (one DISTINCT remains). Covered by `keys-propagation.spec.ts` "Projection isSet soundness".
- `select distinct cat from dup_t` (cat non-key, repeats) → DISTINCT **not** eliminated, returns deduped rows. Same spec.
- `ORDER BY pk DESC, name || 'x'` → trailing expression tiebreaker dropped (pk is unique). `rule-orderby-fd-pruning.spec.ts`.
- All-column GROUP BY / declared-key GROUP BY collapse. `rule-groupby-fd-simplification.spec.ts` (unchanged, still green).
- Key-soundness property harness: `property.spec.ts` `describe('Key Soundness')` — Tier 1 over the node zoo (scan, projection incl. key-dropping, DISTINCT, GROUP BY incl. all-columns, ORDER BY, LIMIT, UNION/ALL/INTERSECT/EXCEPT, inner/left/cross join, nested DISTINCT). Includes a deterministic negative self-test (`fails loudly on an injected over-claim`).

## Known gaps / deferrals (treat as starting points, not finished)

- **Join FK→PK at-most-one recognition via `isUnique` (the ticket's optional, lower-priority item) was DEFERRED.** `rule-join-elimination`, `rule-fanout-lookup-join`, `rule-semi-join-fk-trivial` are **unchanged** — they still prove ≤1-match structurally via `checkFkPkAlignment` / `lookupCoveringFK` on table schemas, never via FDs/keys/`isSet`. This satisfies the acceptance criterion "no false at-most-one" (the untouched FK→PK path was already sound). Adding the `isUnique`-covers-matched-columns recognition would need careful wiring against the existing schema-based equi-column extraction; left for a follow-up if desired. **No reviewer action required for correctness; this is a completeness deferral.**
- **Tier-2 harness (isolated per-node materialization) deferred** to `tickets/backlog/key-soundness-harness-tier2.md` (the `prereq` of this ticket). Tier 1 is the floor and already caught two real bugs.
- **Harness is probabilistic** (numRuns=50, small ranges). It is a soundness floor, not a proof — a reviewer pass over the remaining `isSet` writers (recursive-cte, async-gather, window, values, table-function, asof, returning, cte/cte-reference) is worthwhile. I audited them by inspection (grep) and found them conservatively sound, but did not exhaustively fuzz each (some need specific module/plan shapes the harness's two-table fixture doesn't generate). `recursive-cte-node` (`isSet: !isUnionAll`) and `cte`/`cte-reference` (forward `queryType.isSet`) are the most worth a second look — a set-claiming recursive CTE whose UNION step reintroduces a duplicate would be the analogous bug to the set-operation one fixed here.
- **`keysOf` completeness is intentionally bounded** — no candidate-key subset enumeration. A relation can have a real key that `keysOf` does not list; that only costs an optimization, never correctness.

## Validation performed

- `yarn typecheck` (quereus): clean.
- `yarn workspace @quereus/quereus test`: **3605 passing, 9 pending** (full suite).
- `yarn workspace @quereus/quereus lint`: clean.
- `yarn build` (full monorepo): clean.
- Two existing tests updated to reflect the now-sound (stronger) pruning, with rationale inline:
  - `rule-orderby-fd-pruning.spec.ts`: "Expression trailing key … unchanged" → "… dropped after a unique leading key" (whole-tail pruning is sound: a unique leading key means no ties to break).
  - `monotonic-limit-pushdown.spec.ts`: the multi-key-bail test now disables `orderby-fd-pruning` so a genuine multi-key sort still reaches the pushdown rule (otherwise the trailing tiebreaker is soundly pruned and ORDINALSLICE legitimately fires).
