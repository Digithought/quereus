description: Migrate the delta-binding key-coverage analysis (constraint-extractor) onto the unified keysOf/isUnique surface so FD-derived and empty-key uniqueness facts classify a table reference as 'row'/'group' instead of demoting it to 'global'. Completeness-only — never relaxes soundness.
files: packages/quereus/src/planner/analysis/constraint-extractor.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/analysis/binding-extractor.ts, packages/quereus/test/optimizer/keys-propagation.spec.ts, docs/incremental-maintenance.md
----

## Background

The `unified-key-inference-surface` work (commit `12d9f03f`, in
`tickets/complete/`) landed `keysOf` / `isUnique` in `planner/util/fd-utils.ts`
as the single uniqueness read surface, reconciling all three places a
uniqueness fact can live: declared `RelationType.keys`, the FD set
(`PhysicalProperties.fds`, including FD-derived keys via `deriveKeysFromFds` and
the empty `[]` ≤1-row key via `hasSingletonFd`), and `RelationType.isSet`.

The sibling ticket `empty-key-join-coverage` (also in `plan/`) migrates the
**join** key-propagation paths onto that surface and explicitly carries forward
a review reminder: *"wherever code … only consults `RelationType.keys` instead
of `keysOf` / `isUnique`, it likely drops the ≤1-row case … File follow-up
tickets for any found."* This ticket is one such follow-up, for the
**delta-binding / row-specificity** analysis that drives incremental
maintenance.

## The gap

The binding classifier (`analyzeRowSpecific` → `extractCoveredKeysForTable` →
`computeCoveredKeysForConstraints` in `constraint-extractor.ts`, consumed by
`binding-extractor.ts`) decides whether each `TableReferenceNode` in a
violation / watch / future-MV plan binds as `'row'`, `'group'`, or `'global'`.
Coverage is computed against the table's candidate keys, but those candidate
keys come **only from declared `RelationType.keys`**:

- `createTableInfosFromPlan` (`constraint-extractor.ts:~1354`) maps
  `relType.keys` → `TableInfo.uniqueKeys`.
- `computeCoveredKeysForConstraints` (`~951`) *does* use FDs/ECs — but only to
  expand the equality-covered **column** set under closure
  (`expandEcsToFds` + `computeClosure`). It then checks whether each
  **declared** key is covered. It never treats an FD-derived key (or the
  `∅ → all_cols` empty key) as a candidate key in the first place.

Consequence: a table reference whose uniqueness is provable *only* through FDs —
e.g. a fully PK-constant-bound filter that yields `∅ → all_cols` (≤1-row),
an FD-derived key from a CHECK/assertion-derived premise, or an equi-join EC
that makes a non-declared column set unique — is classified `'global'`. The
delta kernel then re-evaluates that consumer's whole plan on any dependency
change instead of parameterizing per changed PK/group tuple.

This is a **completeness gap, not a soundness bug**: over-classifying as
`'global'` is always correct, just slower (a full re-scan where a keyed seek
would do). Closing it makes assertions, `Database.watch`, and the future
materialized-view consumer dispatch tighter residuals on more plan shapes.

## Scope

1. **Source candidate keys from `keysOf`, not raw `RelationType.keys`.** In the
   coverage path, derive the table reference's candidate keys via the unified
   surface so FD-derived keys and the empty `[]` ≤1-row key participate.
   `TableInfo` already carries `fds` / `equivClasses`; either call `keysOf` on
   the node directly or feed the FD-derived keys into
   `computeCoveredKeysForConstraints` alongside the declared ones.

2. **Empty-key ⇒ unconditional 'row'.** A reference whose `keysOf` includes `[]`
   (≤1-row) is trivially covered with no equality constraints at all — classify
   it `'row'` with an empty key-column list (the existing assertion/binding
   plumbing already special-cases the empty covered key, `covered.push([])` at
   `~998`; verify it flows through `chooseRowKey` and `injectKeyFilter`
   sensibly — an empty `keyColumns` means "≤1 row, no filter needed").

3. **Keep the closure expansion.** The current FD/EC closure of the
   equality-covered column set is correct and should remain — this ticket adds
   FD-derived *candidate keys*, it does not remove the existing column-closure
   step.

4. **Soundness boundary.** Never claim a key that does not hold. `keysOf` is
   sound by construction; the change is purely additive completeness. The
   classifier must still demote correctly across identity-breaking nodes
   (`SetOperation` → global, aggregate group-key coverage, etc.) exactly as
   today.

## Validation expectations

- A violation/watch plan over a fully PK-constant-bound filter (≤1-row via
  `∅ → all_cols`) classifies `'row'` (today: `'global'`); assert via the
  binding classification used by `keys-propagation.spec.ts` / a delta-binding
  unit test.
- A reference made unique only by an FD-derived key (not declared) classifies
  `'row'`.
- No regression in the Tier-1 key-soundness property harness
  (`property.spec.ts` "Key Soundness") — additions are completeness-only.
- No change to existing assertion logic-test results; tighter residuals must
  produce identical violation outcomes (this is dispatch shape, not semantics).
- Update `docs/incremental-maintenance.md` (§ BindingMode / coverage) to state
  that candidate keys come from the unified `keysOf` surface, including
  FD-derived and empty `[]` keys — replacing the current "declared keys + FD
  closure of covered columns" framing.

## Relationship to empty-key-join-coverage

Independent files (join paths vs. delta binding), so not a hard prereq, but the
two share the same migration intent: move every uniqueness consumer onto
`keysOf` / `isUnique`. If `empty-key-join-coverage` lands first, reuse any
shared helper it introduces for "candidate keys of a node including the empty
key" rather than duplicating the `keysOf`-call boilerplate.
