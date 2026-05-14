---
description: Review of new ORDER BY FD pruning optimizer rule
files:
  - packages/quereus/src/planner/rules/sort/rule-orderby-fd-pruning.ts (new)
  - packages/quereus/src/planner/rules/aggregate/rule-groupby-fd-simplification.ts
  - packages/quereus/src/planner/util/fd-utils.ts
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/test/optimizer/rule-orderby-fd-pruning.spec.ts (new)
  - packages/quereus/test/optimizer/monotonic-limit-pushdown.spec.ts (test churn)
  - packages/quereus/test/logic/04-order-by.sqllogic (new)
  - docs/optimizer.md
---

## Summary

Implemented `ruleOrderByFdPruning`, a Structural-pass optimizer rule that
drops trailing `ORDER BY` keys functionally determined by the leading
bare-column keys under the source's FDs and equivalence classes.
Registered at priority 26 (Structural pass) so it lands before
PostOptimization's `monotonic-limit-pushdown` (priority 8) and can convert
shapes like `ORDER BY pk, name LIMIT n OFFSET k` into single-key sorts
that the pushdown rule then accepts.

## Mechanic

The rule walks `node.sortKeys` front-to-back maintaining
`determined = closure({leading bare-column source-indices}, fds, ECs)`.
A trailing bare `ColumnReferenceNode` whose source-attribute INDEX is
already in `determined` is dropped; non-bare-column keys are treated as
opaque (they neither contribute to nor consume `determined`, and are never
droppable). Critical correctness detail: `node.source.physical.fds` lives
in **source-attribute-INDEX space** (positions in
`source.getAttributes()`), NOT attribute IDs — the rule converts each
sort-key's `ColumnReferenceNode.attributeId` to the corresponding source
index, mirroring how `SortNode.computePhysical` already does it for
`leadIdx` lookups.

## Refactor: `expandEcsToFds` promoted to `fd-utils.ts`

The helper previously lived privately in
`rule-groupby-fd-simplification.ts`. It's now a public export in
`packages/quereus/src/planner/util/fd-utils.ts` and the GROUP BY rule
imports from there. No behavior change; the GROUP BY rule's test suite
(`rule-groupby-fd-simplification.spec.ts`) passed without modification.

## Test churn

`packages/quereus/test/optimizer/monotonic-limit-pushdown.spec.ts`: the
"multi-key ORDER BY keeps LIMITOFFSET" negative case used
`ORDER BY id, v` over `t(id INTEGER PRIMARY KEY, v TEXT)`. With the new
rule, `id → v` (PK superkey FD) prunes `v` and the pushdown fires. The
test was updated to use `ORDER BY id, v || 'x'` so the trailing key is a
non-bare expression that the new rule (correctly) leaves alone, keeping
the multi-key bail condition under test.

## What was tested

`packages/quereus/test/optimizer/rule-orderby-fd-pruning.spec.ts`:
- PK-driven (Sort survives via DESC leading key)
- PK-driven (Sort fully elided downstream after pruning to 1-key)
- EC-driven via `WHERE a = b`
- No-FD baseline (compared with rule disabled to confirm no-op)
- Expression trailing key (non-bare → unchanged)
- Three-key partial drop
- Direction irrelevance (`a, b DESC` over `a → b`)
- Direction-mixed-leading (`a DESC, b ASC`)
- Single-key (guard at `< 2 keys`)
- Source attribute identity preserved across the rewrite
- Interaction smoke: ord_seek leaf + multi-key `ORDER BY` → `ORDINALSLICE`
- Behavioral correctness for both PK and EC cases

`packages/quereus/test/logic/04-order-by.sqllogic` (new): PK-driven and
EC-driven cases asserting result rows match the pre-pruned reference
output.

`yarn workspace @quereus/quereus run test`: 2852 passing, 2 pending, 0
failing (no `test:store` run — agent default is fast memory tests).

`yarn workspace @quereus/quereus run lint`: clean.

## Known gaps / things the reviewer should look at

- **Test infrastructure**: positive tests rely on walking the optimized
  plan tree (`db.getPlan(sql)`) and finding the SortNode. Some shapes
  fully elide the Sort downstream (when the leaf's natural ordering
  matches the remaining 1-key sort), so several tests use `pk DESC` to
  keep the Sort node in the plan. This is brittle if a future rule learns
  to serve `pk DESC` from an ascending index by reversing the scan — the
  positive tests would need to switch to `disabledRules` comparison.
- **Reverse direction**: tests use `disabledRules` comparison for the
  "no-FD baseline" but not for positive cases. Adding `disabledRules`
  comparison everywhere would be more robust if the team wants belt-and-
  suspenders.
- **Golden plan fixtures**: did not encounter any golden plan fixtures
  during the run that asserted on multi-key sorts beyond the
  `monotonic-limit-pushdown.spec.ts` case noted above, but the reviewer
  should grep for `ORDER BY .*,` patterns across test fixtures to confirm.
- **`disabledRules: 'orderby-fd-pruning'`** is the disable ID — confirmed
  registered at `packages/quereus/src/planner/optimizer.ts` priority 26.
- The rule reads `node.source.physical.fds` / `equivClasses` (NOT
  `node.physical.fds`). SortNode's `computePhysical` does not currently
  propagate FDs to its own physical, which is fine for this rule but the
  reviewer should note this asymmetry if it confuses anyone reading the
  code.
- `ConstantBinding` is not consumed today; if a column is bound to a
  constant we could also prune trailing keys on it via the same
  mechanism (since `∅ → col` would put `col` in `determined` after the
  first FD closure step). The current rule does not explicitly seed
  `determined` from constants, but `∅ → col` FDs in `sourceFds` are
  already picked up by `computeClosure`. Worth confirming in review.
- Did NOT run `test:store` (per agent guidelines).
