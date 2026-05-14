---
description: Review — extend FD/key propagation through ProjectNode/ReturningNode for projections that are injective in a single source attribute.
files:
  - packages/quereus/src/planner/util/key-utils.ts
  - packages/quereus/src/planner/nodes/project-node.ts
  - packages/quereus/src/planner/nodes/returning-node.ts
  - packages/quereus/src/planner/nodes/scalar.ts
  - packages/quereus/test/optimizer/keys-propagation.spec.ts
  - packages/quereus/test/optimizer/fd-propagation.spec.ts
  - docs/optimizer.md
  - tickets/backlog/4-optimizations-key-preserving-and-sargable-range-rewrites.md
---

## Summary

Project/Returning now propagate `uniqueKeys`, `fds`, and `equivClasses` through projections that are injective in a single source attribute (e.g. `id + 1`, `-id`, `5 - id`, same-logical-type `CAST`), not just bare column references.

## What changed

- **`planner/util/key-utils.ts`** — added `deriveProjectionColumnMap(sourceAttrs, projections)` (with `InjectiveProjectionEntry` and `ProjectionMappingResult` types). Walks each projection: bare `ColumnReferenceNode`s win the `map` slot first; then for each non-bare projection, if its leaves reference exactly one source attribute (other leaves being `LiteralNode` / `ParameterReferenceNode`) AND `expr.isInjectiveIn(attrId).injective === true`, it is treated as a synonym of `src(attrId)` and recorded in `injectivePairs`. Bare-column projections are NOT recorded as injective pairs (they're trivially identity).
- **`planner/nodes/project-node.ts`** — `computePhysical` and `getType()` both call the helper. `uniqueKeys` propagation now substitutes injectively-derived columns into existing keys (so `SELECT id, id+1` gives two unique keys, `[0]` and `[1]`). FDs emit a bi-directional `{bare} ↔ {derived}` pair only when both ends are present in the projection list; otherwise the augmented mapping alone carries the source FDs through to the derived output column. `monotonicOn` still only propagates through bare-column projections (attribute identity is required).
- **`planner/nodes/returning-node.ts`** — same refactor as `ProjectNode`, for both `buildOutputType()` (logical keys) and `computePhysical()` (physical keys/FDs/ECs).
- **`planner/nodes/scalar.ts`** — added `CastNode.isInjectiveIn` override: returns the operand's injectivity when the cast is a logical-type no-op; otherwise `{ injective: false }`. Wider-cast injectivity is intentionally deferred until the type system surfaces a "wider-with-no-collisions" check.

## How to test / validate

Unit tests:
- `packages/quereus/test/optimizer/keys-propagation.spec.ts` — new `describe('deriveProjectionColumnMap', ...)` block exercises the helper directly with synthesized scalar plan nodes (bare passthrough, injective derivation, both-forms collision, two-source-attrs negative case, non-injective negative case, unary minus).

SQL-level optimizer tests:
- Same file, `describe('Injective-projection key propagation', ...)`:
  - `SELECT id + 1 FROM t` (PK `id`) — `uniqueKeys` present on `Project`'s physical.
  - `SELECT -id FROM t`, `SELECT 5 - id FROM t` — same.
  - `SELECT id, id + 1 FROM t` — `uniqueKeys` contains both `[0]` and `[1]`.
  - Negative: `SELECT id + v FROM t` (two source attrs) — no derived key.
  - Negative: `SELECT id * v FROM t` (`*` not injective) — no derived key.
  - DISTINCT elimination: `SELECT DISTINCT id + 1 FROM t` plans without a `DistinctNode`.
- `packages/quereus/test/optimizer/fd-propagation.spec.ts`:
  - `SELECT id + 1 AS k, v FROM t` — source FD `id → v` survives as `{0} → {1}` on `Project`.
  - `SELECT id, id + 1 AS k FROM t` — both `{0} → {1}` and `{1} → {0}` FDs present.
  - Updated existing "non-injective expressions drop out" test to use `v * 2` instead of `v + 1` (the latter now correctly survives).

Lint & test: `yarn workspace @quereus/quereus run lint` + `yarn test` — clean, 2791 passing.

## Use cases unlocked

- DISTINCT elimination across trivial arithmetic (`SELECT DISTINCT id + 1 FROM t`).
- Join-key coverage when the join key is a trivial derivation (`u JOIN (SELECT id + 1 AS k FROM t) ON u.k = t.k`).
- Better cardinality estimates downstream of projections that wrap PK columns.

## Out of scope (per ticket)

- Multi-input joint injectivity (`f(a, b)` injective in the pair).
- Wider-cast injectivity.
- New `injectiveOnArgs` annotations on built-ins (string functions, datetime conversions).
- The sargable-range-rewrite half of `tickets/backlog/4-…` (whose description was updated to note the key-preservation half is now landed).

## Review checklist

- [ ] `deriveProjectionColumnMap` correctly handles edge cases (constant-only projections, identical bare-and-derived collisions).
- [ ] The bi-directional FD is emitted *only* in the both-projected case (single-derivation case must not emit identity FDs).
- [ ] `uniqueKeys` key-substitution does not duplicate keys when the derived column is already in the key.
- [ ] `monotonicOn` still only propagates through bare-column projections (attribute identity).
- [ ] `CastNode.isInjectiveIn` is conservative (same logical type only); wider casts return false.
- [ ] No regression in the existing FD/key propagation tests.
