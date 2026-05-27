description: Migrate the delta-binding key-coverage analysis (constraint-extractor) onto the unified keysOf surface so FD-derived and empty-key uniqueness facts classify a table reference as 'row'/'group' instead of demoting it to 'global'. Completeness-only — never relaxes soundness.
files: packages/quereus/src/planner/analysis/constraint-extractor.ts, packages/quereus/src/planner/analysis/binding-extractor.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/core/database-assertions.ts, packages/quereus/src/planner/analysis/change-scope.ts, packages/quereus/src/runtime/delta-executor.ts, packages/quereus/test/optimizer/row-specific-fd.spec.ts, packages/quereus/test/optimizer/binding-extractor.spec.ts, docs/incremental-maintenance.md
----

## Background

`unified-key-inference-surface` (in `tickets/complete/`) landed `keysOf` /
`isUnique` in `planner/util/fd-utils.ts` as the single uniqueness read surface.
`keysOf(rel: KeyRel)` reconciles all three places a uniqueness fact can live —
declared `RelationType.keys`, the FD set (`PhysicalProperties.fds`, including
FD-derived keys via `deriveKeysFromFds` and the `∅ → all_cols` ≤1-row key via
`hasSingletonFd`), and `RelationType.isSet` — and returns minimal candidate keys
as `readonly (readonly number[])[]`. The empty key `[]` (≤1-row) subsumes all
others in `normalizeKeys`, so when present it is the sole returned key.

## The gap (verified)

The delta-binding classifier decides whether each `TableReferenceNode` binds as
`'row'` / `'group'` / `'global'`. Its candidate keys come **only from declared
`RelationType.keys`**, never from the node's `physical.fds`:

- `createTableInfoFromNode` (`constraint-extractor.ts:~1343`) maps
  `relType.keys` → `TableInfo.uniqueKeys`. It already reads `physical.fds` /
  `physical.equivClasses` into `TableInfo`, but only for the equality-covered
  **column-set closure** — not as candidate keys.
- `extractCoveredKeysForTable` (`~934`) passes `tInfos[0].uniqueKeys ?? []` to
  `computeCoveredKeysForConstraints`.
- `extractConstraints` inline coverage (`~156`) and `classifyForAggregate`
  (`~1198`, `~1224`, `~1240`) likewise consult `tInfo.uniqueKeys` only.

`computeCoveredKeysForConstraints` (`~951`) uses FDs/ECs to expand the
equality-covered **column** set under closure (`expandEcsToFds` +
`computeClosure`), then checks whether each supplied candidate key is covered.
It never treats an FD-derived key or the empty `[]` key as a candidate in the
first place — it only checks the **declared** keys handed to it.

**Confirmed root cause:** `TableReferenceNode.computePhysical`
(`planner/nodes/reference.ts:~106`) materializes `physical.fds` from declared
CHECK constraints (`declared-check`) and hoisted CREATE ASSERTION premises
(`getAssertionHoistedConstraints`). An FD-derived key on a reference — e.g. a
hoisted-assertion FD `{c} → all_cols` making `c` unique though it is not
declared UNIQUE, or a `∅ → all_cols` singleton FD proving ≤1-row — lives on
`physical.fds` and is **invisible** to the current `relType.keys`-only path.
Such a reference is classified `'global'`, so the delta kernel re-evaluates the
whole consumer plan on any dependency change instead of seeking per changed
PK/group tuple.

This is **completeness only, not soundness**: over-classifying as `'global'` is
always correct, just slower. Closing it tightens residuals for assertions,
`Database.watch`, and the future materialized-view consumer on more plan shapes.

(Note: a fully PK-constant-bound *filter* already classifies `'row'` today via
declared-PK coverage — that path is not the gap. The gap is uniqueness provable
*only* through the reference's `physical.fds`.)

## Design

### 1. Source candidate keys from `keysOf`, not raw `RelationType.keys`

Add a `candidateKeys?: number[][]` field to `TableInfo`
(`constraint-extractor.ts:~80`). Populate it in `createTableInfoFromNode` by
calling the unified surface on the node itself:

```ts
// node already satisfies KeyRel (has getType() + physical?)
const candidateKeys = keysOf(node as unknown as KeyRel).map(k => [...k]);
```

This reuses `keysOf` verbatim (DRY — ticket goal #1), so FD-derived keys, the
`∅ → all_cols` empty key, and declared keys all participate, normalized/deduped.
Keep `uniqueKeys` populated as today for the unrelated consumers
(`filter.ts:111`, `project-node.ts:311` build their own `TableInfo`s and are
out of scope) — do **not** remove it.

Switch the three delta-binding consumers to `candidateKeys` (falling back to
`uniqueKeys ?? []` only if `candidateKeys` is somehow undefined, which it should
never be for a node-derived `TableInfo`):

- `extractCoveredKeysForTable` (`~941`): pass `candidateKeys` to
  `computeCoveredKeysForConstraints`.
- `extractConstraints` inline coverage (`~156`): use `candidateKeys`. Note the
  current guard `if (!tInfo.uniqueKeys || tInfo.uniqueKeys.length === 0)` short-
  circuits to `[]`; relax it to consult `candidateKeys` so FD-derived keys are
  not skipped.
- `classifyForAggregate` (`~1198`–`~1240`): use `candidateKeys` in place of
  `uniqueKeys` for the source-space group-key coverage check (same output-column
  space, so the existing key→source mapping applies unchanged).

Keep the existing FD/EC closure expansion of the equality-covered column set in
`computeCoveredKeysForConstraints` — it is correct and orthogonal (ticket goal
#3). This change adds FD-derived *candidate keys*; it does not remove the
column-closure step.

### 2. Empty-key ⇒ unconditional `'row'` with empty `keyColumns`

`keysOf` returns `[[]]` when the reference is ≤1-row. `computeCoveredKeysForConstraints`
already special-cases `key.length === 0` (`covered.push([])`, `~997`), so
`covered` becomes `[[]]` with zero equality constraints needed, and
`analyzeRowSpecific` (`~1055`, `covered.length > 0 ? 'row' : 'global'`) yields
`'row'`. The blocker is downstream:

**`binding-extractor.ts` `extractBindings` (`~92`):** today `chooseRowKey`
returns `[]` for an empty covered key, and line 94 treats `chosen.length === 0`
as "no covered key → global", discarding the ≤1-row `'row'` classification.
Restructure so the empty covered key produces a real row binding:

```ts
const covered = extractCoveredKeysForTable(plan as RelationalPlanNode, relKey);
if (covered.length === 0) {            // defensive: classified row but nothing covered
  perRelation.set(relKey, { kind: 'global' });
  continue;
}
const chosen = chooseRowKey(pkIndices, covered);   // may legitimately be []
perRelation.set(relKey, { kind: 'row', keyColumns: chosen });
```

An empty `keyColumns` means "≤1 row, no filter needed". `chooseRowKey` already
sorts the empty key first (length 0), so it is selected over any non-empty
covered key — correct, since ≤1-row is the strongest fact.

### 3. Verify empty `keyColumns` flows soundly downstream

A `{ kind: 'row'; keyColumns: [] }` binding is new; verify each consumer and add
a sound fallback where empty columns are awkward. **Soundness first** — if any
path cannot cleanly parameterize on zero columns, fall back to `'full'` /
`'global'` for *that consumer* (still correct; the ≤1-row table scanned whole is
equivalent), and document it. Do not loosen any predicate.

- **`database-assertions.ts` `rewriteForKeyFilter` (`~525`):** the
  `for (i = 0; i < keyColumns.length; …)` loop never runs, leaving `predicate`
  null. Read `~540`–`~565` to confirm a null predicate leaves the
  `TableReferenceNode` unwrapped (no filter) rather than crashing or wrapping an
  empty/`true` filter. ≤1-row + no filter is exactly correct here. Add a guard
  if needed.
- **`change-scope.ts` `buildScopeForMode` (`~441`) / `extractRowKeyValues`
  (`~466`):** with empty `keyColumns` the per-column loop produces no tuples.
  Trace what `extractRowKeyValues` returns for empty input (likely `[]` ⇒ the
  existing `values.length === 0` guard falls back to `{ kind: 'full' }`, which
  is sound). If it instead returns `[[]]` (one empty tuple → `{kind:'rows',
  key:[], values:[[]]}`), add an explicit `keyColumns.length === 0 ⇒ full`
  branch.
- **`delta-executor.ts` (`~155`, `getChangedTuples(base, cols, pkIndices)`):**
  with `cols === []`, confirm tuple fetch is well-defined. If empty-column fetch
  is ambiguous, treat an empty-`keyColumns` row binding as `global` at the
  executor (add to `globalRelations`) — sound and simple for a ≤1-row table.

### 4. Soundness boundary

`keysOf` is sound by construction; this change is purely additive completeness.
The classifier must still demote correctly across identity-breaking nodes
(`SetOperation` → global, aggregate group-key coverage) exactly as today — those
paths are untouched except for the candidate-key source.

## Validation expectations

- **FD-derived (non-declared) key ⇒ `'row'`:** construct a table whose
  `physical.fds` carry an FD-derived key not present in declared `relType.keys`
  (a CHECK constraint or hoisted CREATE ASSERTION premise that makes a non-
  UNIQUE column functionally determine the rest). A violation/watch plan with
  equality on that column classifies `'row'` (today: `'global'`). If a working
  SQL scenario is hard to construct, add a focused unit test that feeds
  synthetic FDs through a `KeyRel`/`computeCoveredKeysForConstraints` to prove
  the candidate-key sourcing.
- **Empty key ⇒ `'row'` with `keyColumns: []`:** a reference whose `keysOf`
  includes `[]` (≤1-row via `∅ → all_cols` on the reference) classifies `'row'`
  and `extractBindings` emits `{ kind: 'row', keyColumns: [] }` (today:
  `'global'`).
- **No soundness regression:** Tier-1 key-soundness property harness
  (`test/optimizer/property.spec.ts` "Key Soundness") stays green — additions
  are completeness-only.
- **Identical violation outcomes:** existing assertion logic-tests produce the
  same violation results; tighter residuals are dispatch shape, not semantics.
- **No regression** in `row-specific-fd.spec.ts`, `binding-extractor.spec.ts`,
  `delta-executor.spec.ts`, `keys-propagation.spec.ts`.

## Test surface

- `test/optimizer/row-specific-fd.spec.ts` — has `analyze(db, sql)` →
  `analyzeRowSpecific` and `findFor(result, base)` helpers; add the FD-derived-
  key and empty-key `'row'` classification cases here.
- `test/optimizer/binding-extractor.spec.ts` — assert `extractBindings` emits
  `{ kind: 'row', keyColumns: [] }` for the empty-key case (not `global`).
- `test/incremental/delta-executor.spec.ts` — exercise the empty-`keyColumns`
  binding end-to-end to confirm the chosen downstream fallback behaves.

## Docs

Update `docs/incremental-maintenance.md` § BindingMode (`~113`–`~116`): candidate
keys come from the unified `keysOf` surface — declared keys, FD-derived keys,
and the empty `[]` ≤1-row key — replacing the current "PK among the covered
keys … coverage uses FD closure" framing that implies declared keys only. Note
that an empty `keyColumns` row binding means "≤1 row, no key filter".

## Relationship to empty-key-join-coverage

Independent files (join paths vs. delta binding), so not a hard prereq. Shared
migration intent: move every uniqueness consumer onto `keysOf` / `isUnique`. If
`empty-key-join-coverage` landed first and introduced a shared "candidate keys
of a node including the empty key" helper, reuse it rather than re-deriving the
`keysOf`-call boilerplate.

## TODO

- [ ] Add `candidateKeys?: number[][]` to `TableInfo`; populate in
      `createTableInfoFromNode` via `keysOf(node as KeyRel)`. Keep `uniqueKeys`.
- [ ] Switch `extractCoveredKeysForTable`, the `extractConstraints` inline
      coverage block, and `classifyForAggregate` to use `candidateKeys`.
- [ ] Relax the `extractConstraints` coverage guard so a missing/empty
      `uniqueKeys` no longer short-circuits when `candidateKeys` has FD keys.
- [ ] Restructure `extractBindings` so an empty covered key yields
      `{ kind: 'row', keyColumns: [] }`; only `covered.length === 0` → global.
- [ ] Verify + (if needed) guard empty `keyColumns` in `rewriteForKeyFilter`,
      `buildScopeForMode`/`extractRowKeyValues`, and `delta-executor`; sound
      fallback to `full`/`global` per-consumer is acceptable and documented.
- [ ] Tests: FD-derived-key `'row'` and empty-key `'row'` in
      `row-specific-fd.spec.ts`; empty-`keyColumns` binding in
      `binding-extractor.spec.ts`; end-to-end empty-key in
      `delta-executor.spec.ts`.
- [ ] Run `yarn workspace @quereus/quereus test` (esp. optimizer + incremental
      suites and "Key Soundness") and `yarn workspace @quereus/quereus lint`.
- [ ] Update `docs/incremental-maintenance.md` § BindingMode.
