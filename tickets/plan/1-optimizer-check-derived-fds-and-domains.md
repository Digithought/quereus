---
description: Extract FDs, equivalence classes, constant bindings, and column-domain bounds from declared `check` constraints at schema-load time and feed them into the existing FD/EC/binding pipeline. Adds a new `domainConstraints` physical property for range/enum bounds.
files:
  - packages/quereus/src/schema/table.ts
  - packages/quereus/src/schema/manager.ts
  - packages/quereus/src/planner/nodes/plan-node.ts
  - packages/quereus/src/planner/nodes/table-access-nodes.ts
  - packages/quereus/src/planner/util/fd-utils.ts
  - packages/quereus/src/planner/analysis/
  - packages/quereus/test/optimizer/check-derived-fds.spec.ts
  - docs/optimizer.md
  - docs/architecture.md
---

## Problem

`check` constraints today are validated at write time but invisible to the optimizer. Real schemas encode meaningful structure in checks:

- `check (b = a + 1)` — expression-level functional dependency between columns.
- `check (status = 'active')` — column pinned to a constant for every row.
- `check (status in ('a','i','d'))` — bounded enum domain.
- `check (qty >= 0)` — numeric range bound.
- `check (a = b)` — equivalence class, no expression needed.

Each of these is the same kind of claim that the FD/EC/`constantBindings` framework (see `fd-property-foundation` and `fd-from-equivalence-classes`) already represents. Surfacing them at the table-reference node lets every existing FD consumer benefit (DISTINCT elimination, GROUP-BY simplification, decorrelation, join elimination) without writing new optimizer rules.

This ticket is the foundation for `optimizer-conditional-fds`, `optimizer-predicate-contradiction-detection`, and `optimizer-assertion-as-rewrite-premise` — all three rely on a uniform "constraints become physical properties" path.

## Architecture

### Schema-time extraction

A new analysis pass runs once per table at schema-load (or first reference), walking each declared `check` expression and emitting:

1. **Equality FDs** — `check (col1 = col2)` → bi-directional FD pair + EC entry. `check (col = literal)` → `∅ → col` FD + `ConstantBinding`. `check (b = f(a))` for any deterministic single-column-input expression `f` → `a → b` (one-way). Re-uses `extractEqualityFds` shape; the walker is a generalization of the existing one in `filter.ts`.
2. **Constant bindings** — same as the literal-equality case above, recorded with the existing `ConstantBinding` shape so `closeConstantBindingsOverEcs` propagates them through joins.
3. **Domain constraints** — the new surface this ticket adds (below).

Conjunctions decompose; disjunctions are conservatively skipped at this pass (they can still contribute via the contradiction-detection pass in ticket #4). Subqueries inside checks are skipped. Non-deterministic expressions are skipped.

### New physical property: `domainConstraints`

Add to `PhysicalProperties` in `planner/nodes/plan-node.ts`:

```typescript
export type DomainConstraint =
  | { kind: 'range';
      column: number;            // output column index
      min?: SqlValue;            // inclusive iff minInclusive
      max?: SqlValue;            // inclusive iff maxInclusive
      minInclusive: boolean;
      maxInclusive: boolean }
  | { kind: 'enum';
      column: number;
      values: ReadonlyArray<SqlValue> };

interface PhysicalProperties {
  // ... existing fields ...
  domainConstraints?: ReadonlyArray<DomainConstraint>;
}
```

Notes:
- `notNull` is already a column-schema property; do not duplicate it here.
- Ranges and enums compose: a column with both an enum and a range constraint can be intersected at consumption time (out-of-scope for this ticket; the contradiction-detection ticket will do that work).

### Helpers (new in `fd-utils.ts`)

- `extractCheckConstraints(checkExpr, columnNameToIndex): { fds, ecs, bindings, domains }` — single-pass walker producing all four outputs from one check expression. Reuses `extractEqualityFds` internals where applicable.
- `mergeDomainConstraints(a, b)`, `projectDomainConstraints(domains, mapping)`, `shiftDomainConstraints(domains, offset)` — mirroring the existing FD/EC/binding helpers.

### Per-operator propagation

Domain constraints propagate using the same rules as `constantBindings`:

| Operator | Behavior |
| -------- | -------- |
| `TableReferenceNode` | Seed from extracted check constraints (this ticket's main change). |
| `Filter` | Inherit; intersect with any further range/enum predicates from the filter (defer the intersection logic to ticket #4 — for this ticket, just inherit). |
| `Project` / `Returning` | Project through source→output mapping; drop on non-bare-column outputs. |
| `Aggregate` family | Project through GROUP BY; drop on aggregated columns. |
| `Join` (inner/cross) | Union with right side shifted; outer joins keep preserved-side only; full outer drops both. |
| `SetOperation` | Drop conservatively. |
| `Distinct` / `Alias` / `Window` / scan family | Pass through. |

### Where extraction lives

The analysis pass belongs in `planner/analysis/` (alongside the existing const evaluator and predicate normalizer), called once when `TableReferenceNode.computePhysical` builds its initial property set. Cache the per-table extraction result on the `TableSchema` to avoid re-walking on every reference.

## Test outline (`test/optimizer/check-derived-fds.spec.ts`)

Unit tests on `extractCheckConstraints`:
- `check (a = b)` → bi-FDs + EC pair.
- `check (status = 'a')` → `∅ → status` FD + binding.
- `check (qty >= 0)` → range domain on `qty` (min=0, minInclusive=true).
- `check (qty between 0 and 100)` → range domain (min=0, max=100, both inclusive).
- `check (status in ('a','i','d'))` → enum domain on `status`.
- `check (a = b and status = 'a')` → all of the above (AND-decomposition).
- `check (a = b or x = y)` — disjunction, no contribution.
- `check (a > b)` — non-equality, no FD; no domain (not a single-column bound).

End-to-end via `query_plan(?)`:
- Table with `check (b = a + 1)`: select * shows FDs `a → b`, `b → a`.
- Table with `check (status in ('a','i'))`: select * shows `domainConstraints` containing the enum.
- Table with `check (status = 'a')`: existing DISTINCT-elimination rule fires for `select distinct status from t`.
- Existing GROUP-BY-by-PK simplification triggers when a check pins a non-PK column to a constant.
- Join propagation: domains on the inner side of an inner join survive; outer join drops the nullable side.

## Out of scope

- **Domain intersection at filter time** — done in `optimizer-predicate-contradiction-detection` (ticket #4).
- **Conditional FDs** (`{status='a'} → x`) — done in `optimizer-conditional-fds` (ticket #3); this ticket only handles unconditional checks.
- **Assertion-derived constraints** — done in `optimizer-assertion-as-rewrite-premise` (ticket #5).
- **Foreign-key-derived inclusion dependencies** — separate independent track, see `optimizer-ind-existence-reasoning`.

## TODO (carry to implement)

- Define `DomainConstraint` and add `domainConstraints?` to `PhysicalProperties`.
- Implement `extractCheckConstraints` in `planner/util/fd-utils.ts` (or a new `check-extraction.ts` if it grows).
- Implement domain helpers (`merge`/`project`/`shift`).
- Wire extraction into `TableReferenceNode.computePhysical`; cache on `TableSchema`.
- Extend per-operator `computePhysical` to propagate `domainConstraints` (mirroring `constantBindings` rules).
- Tests per outline above.
- Update `docs/optimizer.md` propagation table; mention check-derived FDs in `docs/architecture.md` §Functional-Dependency Tracking.
