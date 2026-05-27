description: Review the delta-binding key-coverage migration onto the unified keysOf surface — FD-derived and ≤1-row empty keys now classify a TableReference as 'row'/'group' instead of demoting to 'global'. Completeness-only; verify no soundness regression.
files: packages/quereus/src/planner/analysis/constraint-extractor.ts, packages/quereus/src/planner/analysis/binding-extractor.ts, packages/quereus/src/runtime/delta-executor.ts, packages/quereus/src/planner/analysis/change-scope.ts, packages/quereus/src/core/database-assertions.ts, packages/quereus/test/optimizer/row-specific-fd.spec.ts, packages/quereus/test/optimizer/binding-extractor.spec.ts, packages/quereus/test/incremental/delta-executor.spec.ts, docs/incremental-maintenance.md
----

## What landed

The delta-binding classifier sourced its candidate keys from declared
`RelationType.keys` only, so uniqueness provable **only** through a reference's
`physical.fds` (an FD-derived key or a `∅ → all_cols` ≤1-row singleton FD on a
no-PK table) was invisible — the reference fell through to `'global'`. This
change routes candidate keys through the unified `keysOf` surface
(`planner/util/fd-utils.ts`), which reconciles declared keys, FD-derived keys,
the empty `[]` ≤1-row key, and the all-columns set key.

**`constraint-extractor.ts`**
- Added `candidateKeys?: number[][]` to `TableInfo`; populated in
  `createTableInfoFromNode` via `keysOf(node as unknown as KeyRel)`. `uniqueKeys`
  is retained unchanged (other callers — `filter.ts`, `project-node.ts` — build
  their own `TableInfo` literals and still read declared keys).
- Switched the three delta-binding consumers to `candidateKeys`
  (`?? uniqueKeys ?? []` fallback): `extractCoveredKeysForTable`, the
  `extractConstraints` inline coverage block (guard relaxed so empty `uniqueKeys`
  no longer short-circuits when `candidateKeys` carries FD keys), and the three
  `tInfo.uniqueKeys` reads in `classifyForAggregate`.
- The FD/EC closure expansion of the equality-covered **column** set in
  `computeCoveredKeysForConstraints` is untouched (orthogonal, still correct).

**`binding-extractor.ts`** — `extractBindings` restructured: only
`covered.length === 0` → `'global'` (defensive); otherwise emit
`{ kind: 'row', keyColumns: chosen }` where `chooseRowKey` may legitimately
return the empty key `[]` (≤1-row, sorts first by length).

**Downstream empty-`keyColumns` handling (soundness-first fallbacks):**
- `delta-executor.ts` `runOne`: an empty-key `'row'` binding is demoted to
  `globalRelations` (no key columns to fetch per-tuple; `getChangedTuples` is
  never called with `cols=[]`). Sound — scanning a ≤1-row table whole equals
  seeking its single row.
- `change-scope.ts` `buildScopeForMode`: explicit `keyColumns.length === 0 ⇒
  { kind: 'full' }`. (The pre-existing `values.length === 0 ⇒ full` path already
  caught this since `cartesianProduct([]) === []`; the explicit branch documents
  intent.)
- `database-assertions.ts` `tryWrapTableReference`: empty `keyColumns` already
  left the `TableReferenceNode` unwrapped (null predicate → no filter); added a
  clarifying comment. Residual is still compiled but never dispatched per-tuple
  (executor demotes to global).

**Docs:** `docs/incremental-maintenance.md` § BindingMode updated to describe the
`keysOf` candidate-key sourcing and the empty-`keyColumns` ≤1-row semantics.

## Validation done

- `yarn workspace @quereus/quereus typecheck` — clean.
- `yarn workspace @quereus/quereus lint` — clean.
- Full suite (`node test-runner.mjs`): **3636 passing, 9 pending, 0 failing**.
- Optimizer + incremental focused run: 1105 passing, incl. the Tier-1 "Key
  Soundness" property harness and `keys-propagation.spec.ts` — green.

New tests:
- `row-specific-fd.spec.ts`: FD-derived key (no declared key) → `'row'`; ≤1-row
  empty key → `'row'`.
- `binding-extractor.spec.ts`: empty key → `{ kind: 'row', keyColumns: [] }`;
  FD-derived key → `'row'` with non-empty key columns.
- `delta-executor.spec.ts`: empty-key `'row'` binding demoted to global, and
  `getChangedTuples` is asserted **not** called.

## Reviewer focus / known gaps (treat tests as a floor)

1. **Synthetic-ish SQL for the FD-only scenarios.** The end-to-end tests
   manufacture FD-derived / singleton FDs via CHECK constraints on **no-PK**
   memory tables: `CHECK (a = b)` (no PK) yields FD-derived keys `{a}`,`{b}`;
   `CHECK (a = 1 AND b = 2)` yields the `∅ → all_cols` singleton. This is a real
   `physical.fds` path, but I did **not** find a `CREATE ASSERTION` self-join
   uniqueness shape that hoists a `{c} → others` *key* FD — assertion hoisting
   negates `NOT EXISTS(... WHERE P)` to a per-row CHECK and only emits
   `∅ → col` / `col1 ↔ col2` shapes (see `assertion-hoist-cache.ts` /
   `check-extraction.ts`). If a reviewer knows a real hoisted-assertion shape
   that produces a uniqueness key FD, an additional end-to-end case there would
   strengthen coverage. The ticket explicitly permitted the synthetic route.

2. **Broader behavioral change worth a second look:** because `keysOf` emits the
   all-columns key for any `isSet` relation, a **no-PK memory table reference now
   carries an all-columns candidate key**. So a query whose equality covers every
   column (or GROUP BY over all columns) on a no-PK table now classifies
   `'row'`/`'group'` instead of `'global'`. This is sound (a set is unique on all
   columns) and completeness-positive, and the full suite stayed green — but it
   is a wider surface than just the FD-derived-key case the ticket framed.
   Confirm no consumer treats "all-columns row binding" pathologically (the
   delta executor fetches all columns as the key tuple; capture registration in
   `compileUnderSuppression` registers the non-PK columns as extras — exercised
   indirectly, not by a dedicated test).

3. **Empty-key row binding yields no tighter residual than global today.** The
   chosen sound fallback demotes it to global at the executor, so for a ≤1-row
   table the runtime cost is identical to `'global'`. The win is classification
   consistency (correct `keysOf`-driven facts, `change-scope` reports `full`
   rather than mis-deriving, no misclassification cascade through aggregates).
   If a future consumer wants to exploit "≤1 row" for a cheaper dispatch, the
   binding now carries the fact; the executor fallback can be revisited then.

4. **`filter.ts:110-119` now benefits indirectly:** it calls `extractConstraints`
   (which reads `candidateKeys`) but gates on `tableInfo.uniqueKeys` non-empty
   first, so its ≤1-row singleton-FD derivation can now fire via FD-derived keys
   when a declared key also exists. Sound (covering any candidate key ⇒ ≤1 row);
   `project-node.ts` builds its own `uniqueKeys`-only `TableInfo` and relies on
   the `?? uniqueKeys` fallback — unchanged. No dedicated test added for the
   `filter.ts` interaction beyond the passing suite.

## Soundness boundary

`keysOf` is sound by construction; this is purely additive completeness.
Identity-breaking demotion (`SetOperation` → global; aggregate group-key
coverage) is untouched except for the candidate-key source. Over-classifying as
`'global'` was always correct (just slower); the change only tightens, never
relaxes.
