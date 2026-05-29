description: FD-driven "body proves it" coverage primitive (`proveEffectiveKeyUnique`) — an output-relation uniqueness proof delegating to `isUnique`, deliberately kept separate from v1 base-table `proveCoverage` for soundness. Implemented and reviewed.
files: packages/quereus/src/planner/analysis/coverage-prover.ts, packages/quereus/test/covering-structure.spec.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/nodes/aggregate-node.ts, docs/optimizer.md, docs/materialized-views.md, docs/lens.md
----

## Summary

Added `proveEffectiveKeyUnique(root, keyColumns): EffectiveKeyResult` to
`coverage-prover.ts` — the obligation primitive the (not-yet-landed) lens prover
consumes for its `obligation: proved` class. It proves the body's **own output
relation** is unique on a set of *output-column* indices via its effective key,
delegating wholesale to the unified `isUnique` surface (declared keys,
FD-closure-derived keys, all-columns/`isSet` fallback). The implementation is a
thin out-of-frame guard plus the `isUnique` call; the value it adds is the named
seam, the diagnostic result shape (`proved` | `not-a-key` | `out-of-frame`), and
the load-bearing soundness doc block.

The central design decision (a deliberate deviation from the originally-filed
framing) is that this is **NOT** a widening of base-table `proveCoverage`: an
FD-derived output key cannot witness a *base-table* `unique`, because grouping
collapses base-row duplicates and aggregating bodies drop the base PK. The
primitive is therefore kept out of `proveCoverage`; the v1 base-table covering
path and `linkCoveredUniqueConstraints` are unchanged.

`fd-utils.ts` was not modified (`isUnique`/`keysOf` already do everything).

## Review findings

Adversarial pass over commit `f8fed5bc`. Diff read first, then the handoff.

### Soundness argument — audited directly (the ticket's headline ask): HOLDS

- **Reduction to `isUnique` is sound.** `proveEffectiveKeyUnique` adds no
  uniqueness logic; it returns `proved` iff `isUnique(keyColumns, root)`.
  `isUnique` is the codebase's documented soundness-critical superkey predicate
  (`fd-utils.ts`), independently tested in `test/optimizer/keysof-isunique.spec.ts`.
  Any bug there is pre-existing and out of scope.
- **Separation from `proveCoverage` is correct.** Verified `proveCoverage`,
  `provePredicateAlignment`, `linkCoveredUniqueConstraints`, and the
  `PASS_THROUGH` shape walk are byte-for-byte unchanged. The grouping-masks-base-
  duplicates argument is sound: a `group by x` output is unique on `x` regardless
  of base-table duplicates, so it cannot witness a base `unique(x)`. Keeping (2)
  out of (1) preserves the v1 boundary.
- **Out-of-frame guard is load-bearing for soundness, not just diagnostics.**
  Without it, `isUnique([0,1,99], rel)` on an `isSet`/all-columns relation would
  falsely return `proved`, because `keysOf` yields the all-columns key `[0,1]`
  and `[0,1].every(c => colSet.has(c))` passes when `colSet ⊇ {0,1}`. The guard
  rejects the out-of-frame index first. This is exactly covered by the stub
  `[0,5]` mixed-index case.
- **NULL subsumption (strict-unique ⟹ NULL-permissive `unique`) is correct.**
  `isUnique` proves uniqueness treating NULL as a value (strict); SQL `unique` is
  NULL-permissive (weaker); strict ⟹ permissive. For the canonical `group by x`
  (nullable x) case the output is genuinely strictly unique (one NULL group).
  Examined the edge where a declared `RelationType.keys` entry might only encode
  NULL-permissive uniqueness: even then the lens conclusion (discharging the
  logical NULL-permissive `unique`) holds in *both* directions — no soundness
  hole, only the doc's parenthetical "strict" being the conservative framing.
- **Superkey semantics correct.** A superset of a key is a key; `isUnique`
  returns true for any superset, so a real key `⊆ keyColumns` discharges the
  (larger) declared key. Sound for proving.
- **Blast radius is currently zero.** `find_references` confirms
  `proveEffectiveKeyUnique`/`EffectiveKeyResult` are referenced only by their
  definition and the test file — no production consumer yet. The primitive is a
  forward-declared seam for the lens ticket; until that wires it, no enforcement
  decision depends on it. The seam contract (output-column indices; lens owns the
  logical→output mapping) reads cleanly.

### Open question from the handoff — CLOSED

The handoff flagged that the e2e tests assert the group-key FD "only indirectly"
via whichever physical aggregate the planner picks, and asked a reviewer to
confirm both paths surface it. Verified directly: `HashAggregateNode.computePhysical`
and `StreamAggregateNode.computePhysical` both call the shared
`propagateAggregateFds` with identical arguments at the FD-emission site, so the
group-key FD is path-independent. The lens verdict cannot vary by the planner's
physical-aggregate choice. No additional test needed (a forced-path test would
exercise `propagateAggregateFds`, not this primitive).

### Tests — checked happy/edge/error/regression paths

- Happy: composite group key proved, PK-FD-through-projection proved.
- Edge: superset/superkey proved; strict subset → `not-a-key`; nullable group
  key proved; empty `keyColumns` → `proved` only when ≤1-row (stub).
- Error: out-of-frame (≥ count, negative, mixed) → `out-of-frame` (stub + e2e).
- Regression: all 17 pre-existing v1 covering cases stay green.
- Coverage is genuinely thorough for a delegating primitive (e2e against the real
  optimizer + stub unit isolating the guard and delegation). No gaps requiring
  new tests. Undocumented-but-harmless: duplicate indices (e.g. `[0,0]`) are
  deduped by `isUnique`'s `Set` — sound, not worth a test.

### Other dimensions

- **DRY / modularity / SPP:** clean. Single-purpose function, no duplicated
  uniqueness logic, delegates to the shared surface as designed.
- **Type safety:** `EffectiveKeyResult` discriminated union; no `any`. The test
  stub casts a minimal `{getType, physical}` to `RelationalPlanNode`, justified by
  a comment (only those two members are touched) — acceptable for a unit stub.
- **Error handling / resource cleanup:** every e2e test closes its DB in
  `finally`. No exception paths in the primitive (pure, total function).
- **Docs:** read all three touched docs. `optimizer.md` §"Effective-key proving",
  `materialized-views.md` §"Covering structures", and `lens.md` "body proves it"
  bullet all describe the new reality and the output-vs-base-table distinction.
  Verified every cross-doc anchor resolves (`optimizer.md#effective-key-proving-body-proves-it`,
  `materialized-views.md#covering-structures`, `lens.md#constraint-attachment`).
  The stale `coverage-prover-fd-driven-coverage` backlog reference in
  `materialized-views.md` was correctly removed.

### Disposition

- **Minor findings:** none requiring a fix — the implementation is minimal and
  correct as written.
- **Major findings:** none; no new tickets filed.

### Validation (re-run at SHA f8fed5bc, no code changes made during review)

- `yarn workspace @quereus/quereus run lint` → exit 0.
- Targeted `covering-structure.spec.ts` → 26 passing (17 v1 + 9 new).
- `yarn workspace @quereus/quereus run test` (full memory suite) → 3770 passing,
  9 pending, exit 0.

## Follow-ups (unchanged, out of scope here)

- `lens-prover-and-constraint-attachment` — the downstream consumer that wires
  `proveEffectiveKeyUnique` and owns the logical→output column mapping.
- `coverage-prover-multi-source-bodies` — join MVs covering a single-table UC.
- Whether a covering *enforcement* structure (detection-only, ABORT) can ever be
  FD-derived is a separate row-time-enforcement / lens concern.
