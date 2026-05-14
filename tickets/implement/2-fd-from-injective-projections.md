---
description: Extend FD/key propagation through ProjectNode (and ReturningNode) so that injective scalar expressions over a single source attribute carry that attribute's key/FD/EC information through to the projected output.
prereq: fd-property-foundation
files:
  - packages/quereus/src/planner/nodes/project-node.ts
  - packages/quereus/src/planner/nodes/returning-node.ts
  - packages/quereus/src/planner/util/key-utils.ts
  - packages/quereus/src/planner/util/fd-utils.ts
  - packages/quereus/src/planner/nodes/plan-node.ts
  - packages/quereus/src/planner/nodes/reference.ts
  - packages/quereus/src/planner/nodes/scalar.ts
  - packages/quereus/test/optimizer/keys-propagation.spec.ts
  - packages/quereus/test/optimizer/fd-propagation.spec.ts
  - docs/optimizer.md
---

## Goal

`projectKeys` (`planner/util/key-utils.ts:12`) and `ProjectNode.computePhysical` (`project-node.ts:166`) currently only carry a source key/FD through projection when every projected column is a bare `ColumnReferenceNode`. The `ScalarPlanNode.isInjectiveIn(attrId)` surface (already landed) proves something stronger: any projection that is injective in exactly one source attribute (with all other referenced inputs being compile-time constants) is itself a key-preserving projection of that attribute.

So `SELECT id + 1, v FROM t` (where `id` is the PK) should advertise `{id+1}` as a unique key on the output, plus the bi-directional FDs `{src(id)} → {out(id+1)}` and `{out(id+1)} → {src(id)}`. Same for `-id`, `cast(id AS BIGINT)`, etc. This unlocks DISTINCT elimination, join-key coverage, and stats accuracy through trivial arithmetic projections.

## Implementation

### Helper: `deriveInjectiveColumnMap`

In `planner/util/key-utils.ts`, add a small helper that walks projections and augments the source→output column-index mapping with injective-derivation entries. It needs `sourceAttrs` (to translate attrIds to source column indices) plus the projection list:

```typescript
export interface InjectiveProjectionEntry {
  /** The scalar expression being projected. */
  expr: ScalarPlanNode;
  /** Output column index (zero-based in the projected relation). */
  outIndex: number;
}

/**
 * Build a source→output column mapping that includes BOTH:
 *   - direct ColumnReferenceNode projections (bare passthrough)
 *   - injective unary projections: expr references exactly one source
 *     attribute `a`, expr.isInjectiveIn(a).injective is true, and every other
 *     leaf referenced by expr is a compile-time constant (Literal /
 *     ParameterReference). For those, output column `outIndex` is treated as
 *     a synonym of source column `src(a)`.
 *
 * Returns:
 *   - map:           sourceColIdx → outputColIdx (first occurrence wins, as today)
 *   - injectivePairs: [sourceColIdx, outputColIdx] pairs flagged as
 *                    "injectively derived" (used to emit bi-directional FDs).
 *                    Bare-column entries are NOT included here — those are
 *                    already trivially bi-directional via attribute identity.
 */
export function deriveProjectionColumnMap(
  sourceAttrs: readonly Attribute[],
  projections: readonly InjectiveProjectionEntry[],
): { map: Map<number, number>; injectivePairs: Array<[number, number]> };
```

Detection logic for the "exactly one source attribute, all others constant" gate:
- Walk `expr` recursively collecting leaves.
- A leaf is **constant-like** iff it is a `LiteralNode` or `ParameterReferenceNode`.
- A leaf is **column-like** iff it is a `ColumnReferenceNode`. Track its `attributeId`.
- If exactly one *unique* column attrId appears (one or more occurrences of the same attrId are OK — `(id + id)` references one attr), and every other leaf is constant-like, and `expr.isInjectiveIn(thatAttrId).injective === true`, then the projection is injectively derived from that attr. (Note: `id + id` would not actually be injective; `isInjectiveIn` will return false. The gate just lets the call land at `isInjectiveIn`, which is the authoritative answer.)
- If the projection IS a bare `ColumnReferenceNode`, the existing code path handles it; we don't need to walk it.

A subtle case: the same source attribute might be projected multiple times (e.g. `SELECT id, id+1 FROM t`). Today's code uses "first occurrence wins" (`!map.has(srcIndex)` guard). Keep that for the bare-column entry, but accept additional injective derivations too — if both occur, the existing first-wins behavior means the bare column ends up in `map`, and the derived column gets an additional `injectivePairs` entry. That's the desired outcome.

A pathological case: expr references attrId `a` but `src(a)` is not actually a source column (synthesized attribute? subquery scope?). Then `sourceAttrs.findIndex(x => x.id === a) === -1` and we skip it.

### Wire into `ProjectNode.computePhysical`

Replace the current map-building block in `project-node.ts:168–192` so it:
1. Calls `deriveProjectionColumnMap(sourceAttrs, projections)` to build the augmented mapping + injective pair list.
2. Continues to compute `preservedAttrIds` from bare column refs only (the `monotonicOn` propagation rule still requires attribute identity).
3. Uses the augmented `map` for `uniqueKeys`, `projectFds`, `projectedEquiv`, and `projectConstantBindings` (no other changes).
4. After projection, emits the bi-directional FDs from `injectivePairs`: for each `[srcIdx, outIdx]`, add `{map.get(srcIdx)} → {outIdx}` AND `{outIdx} → {map.get(srcIdx)}` via `addFd`. The first FD is redundant when `srcIdx` also maps to a bare projection (both directions just re-state the projection's identity), but `addFd` deduplicates. When `srcIdx` is ONLY in the map via the injective entry itself, the source's other keys/FDs flow through under the augmented mapping; the explicit bi-directional FD captures the "output→source" direction so downstream consumers can substitute the derived column for the source.

   Practically: for the common `SELECT id+1 FROM t` shape, `srcIdx = idx(id)` is in `map` only via the injective entry, so `map.get(srcIdx) = outIdx` and both directions of the FD collapse to `{outIdx} → {outIdx}` — useless. The *useful* effect happens before this step: source FDs like `{idx(id)} → {idx(v)}` flow through `projectFds` with the augmented mapping. So the explicit bi-directional FD is only meaningful when both the source bare column AND the derived expression are projected (`SELECT id, id+1 FROM t`): then it records that the two output columns mutually determine each other.

   **Decision**: emit the bi-directional FD only when the bare-source column ALSO has an output position distinct from the injective one — i.e. when `map.get(srcIdx)` exists from the bare-column pass AND `outIdx !== map.get(srcIdx)`. Otherwise the FD collapses to identity and is skipped. (This is the practical bi-directional FD shape the ticket calls for.)

### Wire into `projectKeys` consumers

`ProjectNode.getType()` (`project-node.ts:91–101`) and `ReturningNode.computePhysical` (`returning-node.ts:225–263`) build the same source→output map from bare projections only. Refactor both to call `deriveProjectionColumnMap` so the logical `RelationType.keys` and the physical `uniqueKeys` on `ReturningNode` pick up injectively-derived keys too.

### Function-trait starter annotations

Verify what already works (no code change expected; just add tests in `expression-properties.spec.ts` or `fd-propagation.spec.ts`):
- Unary `-x` on a numeric operand: `UnaryOpNode.isInjectiveIn` already returns the operand's injectivity (`scalar.ts:111–119`). ✓
- `x + literal`, `x - literal`, `literal + x`, `literal - x`: handled by `BinaryOpNode.isInjectiveIn` (`scalar.ts:310–340`). ✓ (already covered by existing expression-properties tests.)

Code change needed for `CastNode`:
- `CastNode` currently does not override `isInjectiveIn` (`scalar.ts:653`+), so it defaults to non-injective.
- Add a narrow override: `cast(x AS T)` is injective in attrId when `T` is the operand's logical type or strictly wider with no value collisions. Conservative starter rule:
  - Same `logicalType` (cast is a no-op typewise) → pass through `operand.isInjectiveIn(attrId)`.
  - Operand integer → target integer-with-wider range: pass through. (Use `LogicalType` metadata; if there isn't a clean "is wider integer than" check, restrict to "same logical type" only for this ticket and defer the wider-cast case to a follow-up.)
  - All other cases (numeric→text, text→numeric, numeric→smaller-int): return `{ injective: false }` (the default).

  Start with the strict "same logical type" rule. It's defensible and covers the common case where parsing/planning inserts no-op casts. The wider-integer case is small additional value and high risk of subtle wrong answers — defer.

No `concat` annotation in this ticket: the codebase has no scalar `concat` built-in (the `||` operator is a `BinaryOpNode` that already returns `unknown`/`not injective` for non-numeric ops — leaving it that way is safer than threading injectivity through string `||` without a careful collation/coercion review).

## Tests

### `test/optimizer/keys-propagation.spec.ts`

Add cases asserting `uniqueKeys` propagates through:
- `SELECT id + 1 FROM t` where `id` is PK — plan output should include `uniqueKeys` on the Project's physical row.
- `SELECT -id FROM t` (unary minus) — same.
- `SELECT 5 - id FROM t` (literal minus column) — same.
- `SELECT id + ? FROM t` (parameter-as-constant) — same.
- `SELECT id, id + 1 FROM t` — TWO unique keys on the output (one over col 0, one over col 1).
- Negative: `SELECT id + v FROM t` (two source attrs, only one is constant-like is false) — no `uniqueKeys` from injective derivation; only what bare column projections preserve.
- Negative: `SELECT id * v FROM t` — `*` is not annotated as monotone/injective for numeric (per existing tests `expression-properties.spec.ts:269–277`); no projected key.
- DISTINCT elimination: `SELECT DISTINCT id + 1 FROM t` should plan without a `DistinctNode` (similar to the existing "DISTINCT elimination when source has unique keys" assertion).

### `test/optimizer/fd-propagation.spec.ts`

Add end-to-end cases that assert:
- After `SELECT id, id + 1 AS k FROM t`: the Project's physical `fds` contains BOTH `{0} → {1}` and `{1} → {0}` (using `fdHas` already in the file).
- After `SELECT id + 1 AS k, v FROM t`: the source FD `{idx(id)} → {idx(v)}` survives as `{0} → {1}` (the augmented mapping carries it through).

### Unit-level test in keys-propagation (or a new fd-utils-injective.spec.ts)

If practical, add a direct test of `deriveProjectionColumnMap` constructed from synthetic plan nodes (the existing `fd-propagation.spec.ts` already builds these by hand for `extractEqualityFds`; mirror that style).

## Documentation

Update `docs/optimizer.md` around lines 1130–1140 (the per-operator FD/EC table). The `ProjectNode` / `ReturningNode` row currently reads:

> Project FDs/ECs through the source→output mapping built from bare column-reference projections. Non-trivial expressions drop the column out.

Change to describe the injective-derivation extension, with one or two-line example (`SELECT id + 1` keeps the PK; `SELECT id, id+1` adds the bi-directional FD). Reference `ScalarPlanNode.isInjectiveIn` and the function-schema `injectiveOnArgs` trait by name so readers know where to add annotations to enable more rewrites.

No `docs/architecture.md` change.

## Out of scope

- Multi-input joint injectivity (`f(a, b)` injective in the pair). Architecturally separate; deferred.
- Wider-cast injectivity (`cast(int → bigint)`). Defer until the type system surfaces a clean "wider-with-no-collisions" check.
- Annotating additional built-ins (string functions, datetime conversions, etc.). Each needs its own justification — out of scope here.
- The sargable half of `backlog/4-optimizations-key-preserving-and-sargable-range-rewrites.md` (range-rewrite predicate pushdown through monotone expressions). This ticket only covers the key-preservation half; that ticket should be left in place but its description updated by the implementer to note the key-preservation half is now subsumed.

## TODO

- Add `deriveProjectionColumnMap` to `planner/util/key-utils.ts` and unit-test the leaf-walk helper directly.
- Refactor `ProjectNode.computePhysical` to use the augmented mapping; emit the bi-directional FD only when both bare and injective output positions exist for the same source column.
- Refactor `ProjectNode.getType()` and `ReturningNode.computePhysical` to use the same helper for logical/physical key propagation.
- Add `CastNode.isInjectiveIn` override (same-logical-type passthrough only).
- Extend `test/optimizer/keys-propagation.spec.ts` (positive + negative cases).
- Extend `test/optimizer/fd-propagation.spec.ts` (bi-directional FD assertions; cross-column FD survival).
- Update `docs/optimizer.md` Project/Returning row + example.
- Adjust `tickets/backlog/4-optimizations-key-preserving-and-sargable-range-rewrites.md` description to note the key-preservation half is now landed (leaving only the sargable predicate-rewrite half).
- Run `yarn workspace @quereus/quereus run lint` and `yarn test` (full test suite); fix any regressions.
