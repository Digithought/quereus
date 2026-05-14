---
description: Extend FD/key propagation through ProjectNode using `isInjectiveIn` so injective scalar expressions over determining attributes carry the determination through
prereq: fd-property-foundation
files:
  - packages/quereus/src/planner/nodes/project-node.ts
  - packages/quereus/src/planner/nodes/returning-node.ts
  - packages/quereus/src/planner/util/key-utils.ts
  - packages/quereus/src/planner/nodes/plan-node.ts
  - packages/quereus/test/optimizer/keys-propagation.spec.ts
  - packages/quereus/test/optimizer/fd-propagation.spec.ts
  - docs/optimizer.md
---

## Motivation

The `isInjectiveIn(attrId)` surface on `ScalarPlanNode` (completed in ticket `4-expression-properties-injective-monotone`) lets every scalar node answer: "are my distinct values one-to-one with the distinct values of input attribute X?" That property is exactly what's needed to extend key/FD propagation through projection.

Today, `projectKeys` (`planner/util/key-utils.ts:12`) keeps a logical key only when every column in the key is projected as a direct `ColumnReferenceNode`. Same restriction applies to the physical `uniqueKeys` map in `ProjectNode.computePhysical` (`project-node.ts:181`). So:

```sql
SELECT id + 1 AS id2 FROM t   -- id is PK; id2 should be a key, but isn't recognized
SELECT -id     AS nid FROM t   -- same — unary minus is injective
```

The output relation is provably unique on the projected column, but downstream rules (DISTINCT elimination, join-key coverage, cardinality capping) don't know it. The existing backlog ticket `4-optimizations-key-preserving-and-sargable-range-rewrites` proposed this same fix in narrower form (numeric `+/-` constant only); this ticket subsumes that half by going through the general `isInjectiveIn` surface, which handles arbitrary injective transforms including user-defined functions annotated with `injectiveOnArgs`.

## Architecture

### Derived-key extraction

A new helper `deriveProjectionFDs(projections, sourceFds, sourceUniqueKeys)` produces an extended FD set for the output of a `ProjectNode`:

```typescript
interface ProjectionEntry {
  /** The projected scalar expression. */
  expr: ScalarPlanNode;
  /** Output column index in the projected relation. */
  outIndex: number;
}

function deriveProjectionFDs(
  projections: readonly ProjectionEntry[],
  sourceFds: readonly FunctionalDependency[],
  sourceUniqueKeys: readonly (readonly number[])[],
): { fds: FunctionalDependency[]; uniqueKeys: number[][] };
```

For each projection `outIndex = expr`:

1. Identify the set `S = { attrId : expr.isInjectiveIn(attrId).injective }` — input attrs over which `expr` is injective (other inputs held constant).
2. If `expr` references exactly one source attribute `a`, and `a ∈ S`, and all other referenced inputs are constants (literal / `ParameterReferenceNode`), then **the output column `outIndex` is injectively derived from `a`**. We emit the bi-directional FD `{a} → {outIndex}` and `{outIndex} → {a}` (within the source-output column space).
3. After collecting all injective derivations, run the existing `projectKeys` logic, but augment the column-mapping with these injective derivations: a source key `[a, b]` survives as `[outIndex_for_a, outIndex_for_b]` even when `outIndex_for_a` is `a+1` rather than a bare column reference.

The "exactly one source attribute, others constant" gate is conservative on purpose. `expr = a + b` is injective in `a` for fixed `b`, but `b` is not fixed across rows, so the projection of `a + b` is not generally injective in `a`. The gate excludes that case correctly.

### Multi-input injectivity (deferred)

A scalar `expr` may be jointly injective in `(a, b)` — i.e. the pair of input values maps to a unique output. The base lattice (`isInjectiveIn`) is single-attribute. Composite injectivity needs a separate surface or a different reasoning step; deferred to a follow-up.

### Integration with `ProjectNode.computePhysical`

`project-node.ts:181` currently builds `uniqueKeys` by mapping source unique keys through a column-mapping populated only with bare-column projections. Change: also populate the mapping with injective derivations. The existing column-mapping data structure stays; the population step is augmented.

`RelationType.keys` propagation (used by `ProjectNode.getType()`) and `ReturningNode` both use `projectKeys`. Both pick up the change for free once the helper accepts an augmented column-mapping.

### Function-trait annotations

To make the rewrite fire on common functions, annotate at least the following built-ins with `injectiveOnArgs`:

| Function | Injective on arg | Notes |
|---|---|---|
| Unary `-x` (numeric) | arg 0 | Already annotated by composition in `UnaryOpNode`; verify. |
| `x + literal` / `x - literal` | arg 0 | Existing `BinaryOpNode` composition handles it; verify. |
| `lower(x)` | — | NOT injective (loses case) — do not annotate. |
| `upper(x)` | — | Same. |
| `cast(x as same-or-wider-type)` | arg 0 | When provably non-lossy. |
| `coalesce(x, literal)` | — | NOT injective in general (different inputs can collide on the literal). |
| `concat(x, literal)` | arg 0 | Injective: `concat(a,'X') = concat(b,'X')` ⇒ `a = b`. |

Annotations are minimal and add-only — each one needs to be justified individually. This ticket lands the rule + a small starter set; additional annotations come as separate small PRs.

## Use cases enabled

- DISTINCT elimination through arithmetic projections: `SELECT DISTINCT id + 1 FROM t` collapses to `SELECT id + 1 FROM t`.
- Join cardinality capping through arithmetic projections: `(SELECT id*2 AS k FROM t) JOIN u ON u.x = k` recognizes `k` as covering t's key.
- Better stats for derived columns: `joinSelectivity` already uses key coverage to produce `1/ndv` — now applies to derived keys too.
- GROUP BY simplification (`rule-groupby-fd-simplification`) becomes much more powerful once injective expressions carry FDs.

## Tests

Extend `keys-propagation.spec.ts` with cases for arithmetic / unary-minus / cast-widening / string-concat-with-literal projections. Add `fd-propagation.spec.ts` cases that assert both directions of the bi-directional FD show up in `query_plan()` output.

A property test: for any randomly generated injective unary expression `f`, `SELECT DISTINCT f(id) FROM t WHERE id IS NOT NULL` produces the same row count as `SELECT id FROM t WHERE id IS NOT NULL` (and the optimized plan should not contain a `Distinct` node).

## Relationship to existing backlog ticket

`tickets/backlog/4-optimizations-key-preserving-and-sargable-range-rewrites.md` proposes the same key-preservation behavior for a narrow set of expressions (`+ const`, unary `-`). That ticket can either be reduced in scope (to just the sargable range-rewrite half) or marked superseded by this one. **This ticket subsumes the key-preservation half** by routing through the more general `isInjectiveIn` surface.

## Documentation

- **docs/optimizer.md** — update the "Key inference after projections / joins" subsection (currently ~lines 1108–1112) to describe the injective-derivation extension. Add an example. Reference the function-trait annotation requirement (`injectiveOnArgs`).
- No `docs/architecture.md` change required — the architectural shape already documents the projection-FD path; this is a refinement.
