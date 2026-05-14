---
description: Collapse the parallel `uniqueKeys` physical property into the `fds` set now that FDs are first-class and consumers have migrated
prereq: fd-property-foundation, fd-from-injective-projections, fd-from-equivalence-classes, fd-outer-join-key-preservation, rule-groupby-fd-simplification, rule-orderby-fd-pruning, rule-join-elimination-fk-pk, rule-predicate-inference-equivalence, fd-aggregate-predicate-pushdown, fd-change-detection-classification
files:
  - packages/quereus/src/planner/nodes/plan-node.ts
  - packages/quereus/src/planner/util/key-utils.ts
  - packages/quereus/src/planner/rules/distinct/rule-distinct-elimination.ts
  - packages/quereus/src/planner/stats/catalog-stats.ts
  - packages/quereus/src/planner/analysis/constraint-extractor.ts
  - packages/quereus/src/planner/nodes/filter.ts
  - packages/quereus/src/planner/nodes/project-node.ts
  - packages/quereus/src/planner/nodes/stream-aggregate.ts
  - packages/quereus/src/planner/nodes/hash-aggregate.ts
  - packages/quereus/src/planner/nodes/join-node.ts
  - packages/quereus/src/planner/nodes/bloom-join-node.ts
  - packages/quereus/src/planner/nodes/merge-join-node.ts
  - packages/quereus/src/planner/nodes/distinct-node.ts
  - docs/optimizer.md
  - docs/architecture.md
---

## Motivation

The `fd-property-foundation` ticket introduced `PhysicalProperties.fds` as the general representation of "what determines what." For migration reasons it kept `PhysicalProperties.uniqueKeys` in place: every entry in `uniqueKeys` is also expressible as an FD `key → all_columns`, but existing consumers (`rule-distinct-elimination`, `analyzeJoinKeyCoverage`, `CatalogStatsProvider.joinSelectivity`, `Filter.computePhysical`'s covered-key fast path, etc.) read `uniqueKeys` directly.

Two parallel surfaces for the same information is a maintenance hazard:

- Every new operator's `computePhysical` has to remember to populate both.
- Bugs creep in when one is updated and the other isn't.
- Consumers split between the two interfaces — some new rules read `fds`, some legacy rules read `uniqueKeys`.

Once all the consumer rules from the FD suite have landed and verified, this ticket collapses the two surfaces. The cleanup is intentionally last in the FD sequence because reversing it (un-collapsing) costs more than landing it; we want to be confident the FD surface is correct and well-exercised first.

## Architecture

Two viable end states; this ticket picks (B) but documents (A) for context.

### Option A — `uniqueKeys` becomes a derived view

`uniqueKeys` stays in the type system but is computed lazily from `fds`:

```typescript
get uniqueKeys(): number[][] {
  return this.fds
    ?.filter(fd => fdCoversAllColumns(fd, this.columnCount))
    .map(fd => [...fd.determinants])
    ?? [];
}
```

Existing consumers continue to work. Downside: dual presence in the type, two ways to spell the same query, the maintenance hazard persists in shape if not in update points.

### Option B — Remove `uniqueKeys` entirely (recommended)

Every consumer that reads `uniqueKeys` is migrated to read `fds` and filter for "covers all columns" (or, more usefully, to ask `determines(X, allColumns, fds)` via the closure helper). The property is removed from `PhysicalProperties`.

Migration is mechanical:

| Caller | Before | After |
|---|---|---|
| `rule-distinct-elimination` | check `sourcePhys.uniqueKeys?.length > 0` | use `hasAnyFullCoverFd(sourcePhys.fds, attrs)` |
| `analyzeJoinKeyCoverage` `coversPhysicalKey` | iterate `phys.uniqueKeys` | iterate `phys.fds`, filter for full-cover |
| `Filter.computePhysical` covered-key check | walk `sourcePhys?.uniqueKeys` | walk full-cover FDs from `sourcePhys?.fds` |
| `analyzeRowSpecific` | `uniqueKeys = tInfos[0].uniqueKeys` | derive from `fds` |
| `CatalogStatsProvider.joinSelectivity` | reads from `TableSchema` directly (logical keys, not affected) | unchanged |

A small adapter helper makes the migration tidy:

```typescript
function fullCoverKeys(fds: ReadonlyArray<FunctionalDependency> | undefined, columnCount: number): number[][] {
  if (!fds) return [];
  return fds
    .filter(fd => fd.dependents.length === columnCount /* or fd.coversAll flag */)
    .map(fd => [...fd.determinants]);
}
```

But callers should prefer the closure-based question (`determines(determinants, allColumns, fds)`) over the structural "is this a full-cover FD" check — the latter is brittle if the FD set isn't normalized to all-columns dependents.

### `RelationType.keys` (logical) unchanged

The schema-side `RelationType.keys` (`common/datatype.ts:62`) is a separate concern. It's the *declared* uniqueness on a relation type — schema input. Different lifecycle from physical properties; keep it.

This ticket only touches the physical `PhysicalProperties.uniqueKeys` field.

### FD normalization invariant

For the migration to be safe, every operator that previously produced `uniqueKeys` must now produce equivalent FDs whose dependents cover *every column* of the output. Specifically:

- `DistinctNode` → FD `{all_columns} → {all_columns}` (loop-back, equivalent to the all-columns key).
- `StreamAggregateNode` / `HashAggregateNode` with GROUP BY → FD `{groupBy} → {all_output_columns}`.
- `StreamAggregateNode` / `HashAggregateNode` without GROUP BY → FD `∅ → {all_output_columns}` (singleton).
- `FilterNode` covered-key → FD `∅ → {all_columns}` (the `[[]]` singleton marker becomes a `∅ → all` FD).
- `TableReferenceNode` → FD `{pk} → {all_other_columns}` (already the case after foundation).
- Join unique-key propagation → corresponding FDs on the propagated key columns.

An invariant assertion can be enforced at validation time: every operator that claims `estimatedRows ≤ 1` MUST carry an FD `∅ → all_columns` (the singleton FD). Same shape as the `[[]]` marker, in FD terms.

### Test migration

The existing `keys-propagation.spec.ts` and the per-operator key tests must be updated to assert on the FD surface instead of `uniqueKeys`. The tests' assertions become more precise (closure-based) but the high-level shape stays. A regression check: run the full SQL logic suite with `uniqueKeys` removed; if any plan-shape test fails because it asserts on the old field, it's a stale test, not a bug.

### query_plan() output

`query_plan()` exposes physical properties to SQL-level inspection. After the cleanup, the `uniqueKeys` column in the output is replaced by an `fds` column showing the FD set in a compact form. Document the format change.

## Use cases enabled

- Single source of truth for "what determines what" on every plan node.
- Reduced maintenance burden when adding new operators.
- Plan-shape tests get more precise — they can assert specific FDs rather than just "some key exists."
- Future FD-driven optimizations don't have to remember to populate `uniqueKeys` for backward compatibility.

## Tests

- All existing key-propagation tests pass against the FD surface.
- The validation pass enforces the singleton FD invariant.
- A specific test that `query_plan()` output exposes `fds` and no longer mentions `uniqueKeys`.
- The full SQL logic suite passes unchanged — this is a refactor, not a feature change.

## Documentation

- **docs/optimizer.md** — update `PhysicalProperties` interface listing to remove `uniqueKeys`. Update every example that references the field. Replace "Key-driven row-count reduction" subsection examples with FD-based equivalents.
- **docs/architecture.md** — if any references to physical `uniqueKeys` exist (vs the logical `RelationType.keys`), update to point at `fds`.

## Out of scope

- Touching `RelationType.keys` (logical, schema-side). That's a separate question and has different consumers.
- Cleaning up vtab `BestAccessPlanResult.uniqueRows: boolean` — that's an access-plan-level signal from a vtab module about its own output, structurally separate from the plan-node-level `uniqueKeys`. May warrant a parallel cleanup but not part of this ticket.

## Why this comes last

The FD-from-injective-projections, FD-from-equivalence-classes, outer-join-FD, and the four consumer rules all assume `uniqueKeys` is available during transition. Removing it before they land creates merge churn and the risk of subtle regressions. The cleanup must be the trailing step. Listed `prereq:` makes this ordering explicit.
