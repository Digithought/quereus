---
description: Review the monotonic range-scan recognition rule and its diagnostic annotation
prereq: monotonic-on-characteristic, bestaccessplan-monotonic-ordering
files: packages/quereus/src/planner/analysis/constraint-extractor.ts, packages/quereus/src/planner/rules/access/rule-monotonic-range-access.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/nodes/table-access-nodes.ts, packages/quereus/test/optimizer/monotonic-range-scan.spec.ts, packages/quereus/test/optimizer/predicate-analysis.spec.ts, packages/quereus/test/vtab/test-monotonic-decline-module.ts, docs/optimizer.md
---

## What was built

Added the monotonic range-scan recognition layer that sits on top of the existing constraint-extraction + advertisement plumbing. It introduces a passive `rangeBoundedOn` annotation on physical access leaves and a defensive `monotonicOn` drop when a Filter sits directly above a leaf carrying an unhandled range/equality on the monotonic column.

### New surface area

- `PhysicalProperties.rangeBoundedOn?: { attrId; lower?; upper? }` (`packages/quereus/src/planner/nodes/plan-node.ts`)
  Symbolic bound annotation for EXPLAIN and downstream rules. Half-open ranges omit `lower`/`upper`. `valueLiteral` is populated when the bound is a literal; absent for parameter / correlated bounds.

- `IndexScanNode`, `IndexSeekNode`, `SeqScanNode` each gained two optional constructor parameters (`packages/quereus/src/planner/nodes/table-access-nodes.ts`):
  - `rangeBoundedOn?: PhysicalProperties['rangeBoundedOn']` — merged into the leaf's `computePhysical` output.
  - `suppressMonotonic?: boolean` — when true, the lifted `monotonicOn` and the implied `accessCapabilities` are stripped before being merged.

- `rule-monotonic-range-access` (`packages/quereus/src/planner/rules/access/rule-monotonic-range-access.ts`)
  Two responsibilities, dispatched on input node type:
  - **Annotation pass** (when input is `IndexScan` / `IndexSeek` / `SeqScan`): if the leaf advertises `monotonicOn(x)` and its `FilterInfo.constraints` carries a handled range/equality on `x`, set `rangeBoundedOn`. Literal extraction reads from `IndexSeekNode.seekKeys` parallel to `FilterInfo.constraints[i].argvIndex`.
  - **Defensive drop pass** (when input is `Filter`): if the Filter's source is a leaf with `monotonicOn(x)` and the predicate canonicalises to a range/equality on `x` (extracted via `extractConstraints`), clone the leaf with `suppressMonotonic = true` so downstream rules see a non-monotonic stream.

- Registered in `PassId.PostOptimization` at priority 9, on each of the four targeted node types: `IndexScan`, `IndexSeek`, `SeqScan`, and `Filter` (`packages/quereus/src/planner/optimizer.ts`).

### Recognition coverage

| SQL shape | Recognised by | `rangeBoundedOn` set |
| --- | --- | --- |
| `x BETWEEN a AND b` | yes (decomposed to `>=`/`<=` by extractor) | yes |
| `x >= a AND x <= b`, `x >= a AND x < b`, `x > a AND x <= b`, `x > a AND x < b` | yes | yes |
| `x = c` | yes (degenerate range when leaf advertises `monotonicOn` for equality, which memory module does not) | conditionally |
| half-bound `x >= a` / `x < b` alone | yes | yes (only one side populated) |
| `x IN (c1, c2, …)` | no — multi-IN multi-seek emits non-monotonic; memory module declines `monotonicOn` for it; rule no-ops | no |

## Phase-1 audit

Extended `packages/quereus/test/optimizer/predicate-analysis.spec.ts` with a "Canonical-form audit (monotonic range patterns)" describe block that pins down the canonical constraint shape produced by `extractConstraints` for every recognition pattern. No fixes to `constraint-extractor.ts` were needed — the existing extractor already produces canonical form for all shapes in the table.

## Tests

- `packages/quereus/test/optimizer/monotonic-range-scan.spec.ts` — 16 tests covering:
  - All 7 recognition patterns (BETWEEN, ≥/≤, ≥/<, >/≤, >/<, half-bound ≥, half-bound <).
  - Edge cases: empty range, single-element range, multi-IN.
  - Diagnostics: `physical` JSON contains `"rangeBoundedOn"` with the expected shape.
  - Negative cases: no WHERE clause, equality on PK (memory module doesn't advertise `monotonicOn`), rule-disabled tuning.
  - Defensive: a custom test vtab (`packages/quereus/test/vtab/test-monotonic-decline-module.ts`) that advertises `monotonicOn` while declining range filters; the rule must drop `monotonicOn` from the leaf when a residual `FilterNode` sits above it.

- `packages/quereus/test/optimizer/predicate-analysis.spec.ts` — 21 tests total (10 new in the canonical-form audit block).

## Validation

- `yarn workspace @quereus/quereus exec tsc --noEmit` — clean.
- `yarn workspace @quereus/quereus lint` — clean.
- `yarn workspace @quereus/quereus test` — 2623 passing, 2 pending, 0 failing (full suite, ~59s).
- `yarn build` — clean monorepo build.

## Use cases for review

- Confirm the `suppressMonotonic` plumbing on each leaf type (`IndexScan`/`IndexSeek`/`SeqScan`) is correct and survives `withChildren` reconstruction. Both `rangeBoundedOn` and `suppressMonotonic` are propagated through `withChildren`.
- Confirm the rule's pattern-matching against `FilterInfo.constraints` correctly distinguishes EQ from GE/GT/LE/LT (the EQ case lifts both bounds to a degenerate range; this only fires when the underlying access plan advertises `monotonicOn` for equality, which the memory module does not — but the code path is exercised conceptually by the unit-level `extractRangeBounds`).
- Confirm the defensive drop only fires when a Filter is directly above a leaf — the rule's `applyDefensiveDrop` keys off `filter.source` being an access leaf, not a transitive descendant.
- Confirm composition with other PostOptimization rules: priority 9 places it after `monotonic-limit-pushdown` (priority 8) and `join-physical-selection` (priority 5). `monotonic-merge-join` (priority 4) and `lateral-top1-asof` (Structural, priority 5) run earlier in their respective passes; range-bounded leaves still satisfy them via `physical.monotonicOn`.

## Known limitations / follow-ups

- `rangeBoundedOn` is a passive annotation; no other optimizer rule reads it today. Future range-statistics-driven costing rules can plumb it in without further leaf changes.
- `SeqScanNode` does not currently carry an `AccessPathAdvertisement` (the `createSeqScan` helper hard-codes a default `FilterInfo`). The rule's annotation pass on `SeqScanNode` is therefore effectively dead code today — it only fires when `physical.monotonicOn` is set, which `SeqScanNode` never is in current vtab modules. Wiring an advertisement onto `SeqScanNode` is out of scope here; if a future module advertises `monotonicOn` on a seq scan, the rule already handles it.
- The defensive drop is detected by re-canonicalising the Filter's predicate via `extractConstraints` on every match. For dense plans this is cheap, but a future optimisation could thread the parent Filter's already-extracted constraints into the rule via the `OptContext`.
