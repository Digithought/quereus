---
description: Extend `analyzeRowSpecific` to use FD closure for covered-key detection and to emit a 'group' classification when an aggregate's GROUP BY (plus its FD closure) covers a unique key
prereq: fd-property-foundation, fd-from-equivalence-classes, fd-from-injective-projections
files:
  - packages/quereus/src/planner/analysis/constraint-extractor.ts
  - packages/quereus/src/planner/util/fd-utils.ts (computeClosure / expandEcsToFds — read-only, already provided)
  - packages/quereus/src/core/database-assertions.ts (consumer)
  - packages/quereus/src/func/builtins/explain.ts (consumer)
  - packages/quereus/test/optimizer/row-specific-fd.spec.ts (new)
  - docs/architecture.md
  - docs/optimizer.md
---

## Motivation

The assertion delta-execution pipeline classifies each `TableReferenceNode` instance in an assertion plan as `'row'` (≤1 row per changed key) or `'global'` (potentially many rows). The current `analyzeRowSpecific` in `packages/quereus/src/planner/analysis/constraint-extractor.ts:943` uses superkey-by-equality as its only criterion, and `demoteForIdentityBreakingNodes` then demotes any reference beneath an aggregate (unless `GROUP BY` literally equals a unique key), set operation, or window.

That logic predates the FD foundation. With FDs already propagated through every plan node we can do strictly better:

- **FD closure on covered keys.** A column is "covered" if equality constraints on the path determine it. The closure of equality-covered columns under the source's FDs is the set of columns that *must* be uniquely determined. If that closure includes a unique key, the reference is row-unique. Today we only check direct equality coverage.
- **GROUP BY by-key via FD closure.** `GROUP BY a, b` where `(a, b)` covers a UNIQUE on the underlying table (directly OR via FD closure at the aggregate's input) produces row-unique aggregate output. The reference is **group-specific** — ≤1 aggregate output per group key. Today this demotes to `'global'` unless the GROUP BY columns literally match a unique key column-for-column.
- **Window does not multiply rows.** A `WindowNode` emits one output row per input row; it preserves row identity. Today we conservatively demote everything beneath a Window to `'global'`. Fix: don't demote on Window.

This ticket extends `analyzeRowSpecific` to use FD closure, introduces a `'group'` classification with the associated group-key columns, and refines the window/aggregate demotion rules. Runtime wiring for the new `'group'` mode is **out of scope** — see `fd-view-maintenance-binding-keys`. Existing consumers (`database-assertions.ts`, `explain.ts`) must continue working; for now they treat `'group'` as `'global'` (full violation query) until the runtime ticket lands.

## Architecture

### Updated classification API

```typescript
type RowClassification = 'row' | 'group' | 'global';

interface RowSpecificResult {
  /** Per-relationKey classification. */
  classifications: Map<string, RowClassification>;
  /** For group-classified relations, the group key columns expressed as
   *  output column indices on the underlying table reference. */
  groupKeys: Map<string, number[]>;
}

export function analyzeRowSpecific(plan: RelationalPlanNode | PlanNode): RowSpecificResult;
```

The two existing call sites (`database-assertions.ts:172`, `explain.ts:779`) destructure the result. Both today iterate `for (const [relKey, klass] of <returnedMap>)` — switch them to iterate `classifications`. Until the runtime ticket lands, both consumers treat `'group'` as `'global'` (assertions run the full violation query; `explain` shows the class and the group-key column list).

### Covered-key detection with FD closure

`extractCoveredKeysForTable` in `constraint-extractor.ts:899` and the inline `coveredKeysByTable` build in `extractConstraints` (lines ~140–168) currently compute coverage as "every column of a unique key is in the equality set." Extend both code paths to:

1. Gather the equality-covered column index set `E` (existing logic).
2. Resolve the table reference's physical FDs and ECs (the table reference node already publishes them via `computePhysical` — see `reference.ts:97` for the FD emission and the `FilterNode.computePhysical` precedent in `filter.ts:65` for how to compose source FDs with predicate FDs).
3. Compute `closure = computeClosure(E, expandEcsToFds(equivClasses, fds))` using `packages/quereus/src/planner/util/fd-utils.ts:24` (`computeClosure`) and `:48` (`expandEcsToFds`).
4. A unique key is covered if every column in it is in `closure`.

Hoist the inline body of the `coveredKeysByTable` loop in `extractConstraints` into a shared helper that also takes `(fds, ecs)` so both sites call the same closure-aware logic. `computeCoveredKeysForConstraints` (line 913, currently exported) becomes the natural home — extend its signature to accept optional `fds`/`ecs` and update its one external caller (`extractCoveredKeysForTable:907`) to pass them in.

The TableInfo struct (line 71) needs to carry FD/EC info. Extend `TableInfo` with `fds?: readonly FunctionalDependency[]` and `equivClasses?: readonly (readonly number[])[]`, populated from the table reference node's physical properties inside `createTableInfoFromNode` (line 1157).

### `'group'` classification

After the existing `analyzeRowSpecific` loop classifies each relation as `'row'` or `'global'`, the demotion pass walks the tree. Replace `demoteForIdentityBreakingNodes` and `demoteForAggregate` with a `classifyForIdentityBreakingNodes` pass that can both *demote* (`row → global`) and *promote-to-group* (`global → group` when the aggregate's grouping is key-aligned by FD closure).

For each `AggregateNode` / `StreamAggregateNode` / `HashAggregateNode` encountered:

1. Extract the GROUP BY column attribute IDs (only bare `ColumnReferenceNode` group-by expressions count; computed expressions can't be FD-traced through aggregation, mirroring the existing rule).
2. Translate them to source-relative column indices on the aggregate's source.
3. Take FDs and ECs from `aggNode.source.physical` (via `getPhysicalProperties()` / cached). Compute `closure(groupByCols)`.
4. For each table reference beneath the aggregate's source:
   - Find a unique key of the table reference whose columns (mapped through any wrappers between the aggregate's source and the table reference) lie in `closure`.
   - **The mapping problem.** A table reference's keys are stated in its own output indices; the aggregate's source emits some projection of them. The simplest correct path: collect the column indices the table reference exposes through `tInfo.columnIndexMap`, then check whether those same column indices appear in `closure` *at the aggregate's source level*. The `physical.fds` already encode the projection, so the closure computed on the aggregate's source uses source-side indices throughout. The match condition is therefore: the table reference's unique key columns, expressed via the source's columns through the chain, are all members of `closure`. For simple chains (Aggregate over TableReference, possibly with Filter/Project that preserves columns) the indices are the same. For chains with reprojection, fall back to identifying covered keys *at the table-reference level* using the table reference's local closure and a separate "the aggregate's source FDs determine the table reference's PK" check. **Implementation note:** for the first pass, use the table reference's own physical FDs (which already include FK→PK FDs from the table schema). When the GROUP BY is on a column whose closure under the table reference's local FDs covers a unique key of that table, classify the reference as `'group'` with `groupKeys = [the_group_by_column_index_on_this_table]`. This covers the canonical case ("GROUP BY FK column where FK references a PK on a *different* table beneath" — no, that's a different relation; "GROUP BY a column that functionally determines this table's PK via local FDs/ECs").
5. If `'group'`: record the GROUP BY column indices in `groupKeys`. If multiple bare-column GROUP BY columns map to the table reference, pick the **minimal** subset whose closure covers a unique key (greedy: remove columns one at a time, keep removals that don't break coverage).
6. If `'row'` already (from equality coverage at a Filter beneath the aggregate), leave it as `'row'` — equality coverage is stronger than group coverage.
7. If neither: stays `'global'`.

For `SetOperation`: keep the current "demote everything beneath" behaviour. Per-branch refinement is deferred.

For `WindowNode`: **remove** the unconditional demotion. Windows preserve input row count, so a Filter beneath a Window that covered a key is still row-specific. The existing `demoteAllBeneath` call for `Window` (around line 982) goes away; continue recursion into children.

### Consumer wiring

- `database-assertions.ts:172` and `:227`: change `for (const [relKey, klass] of classifications)` to `for (const [relKey, klass] of cached.classifications.classifications)` (or destructure earlier). Treat `'group'` like `'global'` in this ticket — fall through to `executeViolationOnce`. Add a `// TODO(group)` referencing this ticket and the next runtime ticket.
- `explain.ts:779`: emit the classification verbatim (`'row'` / `'group'` / `'global'`). When `'group'`, also serialize the group key column names in the `prepared` column instead of PKs — pull names from the table's schema using the `groupKeys` indices.

### Tests

New file: `packages/quereus/test/optimizer/row-specific-fd.spec.ts`. Use the existing optimizer-test pattern from `packages/quereus/test/optimizer/fd-propagation.spec.ts` for plan inspection.

Key cases:
- `select count(*) from orders group by customer_id` classifies the `orders` reference as `'group'` with `groupKeys = [customer_id_column_index_in_orders]`. Requires `orders` to have FK→customers, but the FK doesn't affect the local FD closure here; what matters is that grouping by `customer_id` makes the *aggregate output* row-unique per customer.
- `select ... group by a, b having a = b` (after EC-derived FD `a → b` / `b → a` lands from `fd-from-equivalence-classes`) — the minimal group key is `[a]`.
- `select count(*) from t group by non_key_col` where the closure of `{non_key_col}` does not include a key: `'global'`.
- `select ... from t where pk = 1` beneath a `WindowNode`: classifies as `'row'` (no longer demoted by Window).
- Equality on a single column whose closure (via existing FK→PK FDs from table-reference physical FDs) covers the PK of *that same* table reference: classifies as `'row'`. Confirms the closure-based covered-key path works on Filter.
- Aggregate without GROUP BY (degenerate single-group aggregate): output is one row, so `'row'` (the empty key case already exists — keep that branch).

## Documentation

- `docs/architecture.md` — section discussing assertion / constraint enforcement: add a paragraph that classification has three outcomes (`row`, `group`, `global`) and that `group` recognition uses FD closure of the aggregate's GROUP BY.
- `docs/optimizer.md` — update the "Row-specific vs Global Classification for Assertions" section (~lines 1113–1219) to describe the FD-closure-based covered-key rule and the new `group` classification. Update the "Binding-aware Delta Planning" section (~1220–1247) to point at the new `RowSpecificResult` shape. Note the deferred runtime wiring for `group`.

## Out of scope

- Runtime execution of `'group'`-classified references in `database-assertions.ts` (parameterized per-group delta evaluation). This ticket only emits the classification; the runtime ticket (`fd-view-maintenance-binding-keys` or successor) wires it in. Until then, `'group'` falls back to the full violation query.
- Per-branch classification of `SetOperation` table references.
- Cross-relation FD propagation through arbitrary projections between the aggregate and the table reference. The first pass uses the table reference's own physical FDs and the aggregate's source FDs; if reality demands chained-projection key tracing, file a follow-up.

## TODO

Phase 1 — extend covered-key detection with FD closure

- In `TableInfo` (`constraint-extractor.ts:71`), add optional `fds` and `equivClasses` fields. Populate them in `createTableInfoFromNode` (line 1157) from the node's `getPhysicalProperties()` (use the relevant helper that's already used by other consumers — see `filter.ts:65` for how it composes source physical FDs into the working set).
- Extend `computeCoveredKeysForConstraints` (line 913) to take optional `(fds, ecs)`, compute the FD closure of the equality-covered column set via `computeClosure(eqCols, expandEcsToFds(ecs, fds))`, and use the closure for coverage testing.
- Refactor the inline coverage loop in `extractConstraints` (lines ~140–168) to call the extended helper.
- Update `extractCoveredKeysForTable` (line 899) to pass FDs/ECs from `TableInfo` through.

Phase 2 — introduce three-way classification

- Define `RowClassification = 'row' | 'group' | 'global'` and `RowSpecificResult` in `constraint-extractor.ts`.
- Change `analyzeRowSpecific` (line 943) to return `RowSpecificResult`. Initial classification path (covered-key from equality + closure) emits `'row'` or `'global'`.
- Replace `demoteForIdentityBreakingNodes` with a `classifyForIdentityBreakingNodes` that can both demote and promote-to-`'group'`.
- In the aggregate handler: compute closure of the GROUP BY bare-column attribute IDs at the aggregate source's FD context (`aggNode.source` physical properties). For each table reference beneath, if (a) closure covers one of that reference's unique keys, classify `'group'` and record the minimal GROUP BY column subset; (b) closure doesn't but a `'row'` classification already stands (Filter equality on path), keep `'row'`; (c) else `'global'`. Keep the `groupBy.length === 0` case: aggregate without GROUP BY emits one row total → `'row'`.
- In the `Window` handler: drop the demotion (just recurse into children).
- Keep the `SetOperation` blanket demotion.

Phase 3 — update consumers

- `database-assertions.ts`: switch the two `for ... of classifications` loops to iterate `cached.classifications.classifications` (or rename the cached field). For now treat `'group'` like `'global'` — falls into `requiresGlobal` / `executeViolationOnce`. Leave a `TODO(fd-view-maintenance-binding-keys)` comment at the `'group'` branch.
- `explain.ts`: emit the classification verbatim; for `'group'`, set the `prepared` column from the group key column names instead of the PK names.

Phase 4 — tests

- Add `packages/quereus/test/optimizer/row-specific-fd.spec.ts` covering the cases listed under "Tests" above. Use `db.eval` on plan-inspection TVFs the way `fd-propagation.spec.ts` does, or call `analyzeRowSpecific` directly on the optimized plan node tree if the test harness supports it (check `fd-equivalence.spec.ts` for whichever pattern is canonical in this repo).

Phase 5 — docs

- Update `docs/optimizer.md` rows-specific / binding-aware-delta sections.
- Update `docs/architecture.md` assertion section.

Phase 6 — verify

- `yarn workspace @quereus/quereus run lint` (single-quote the glob on Windows).
- `yarn test` — both new spec and the existing `database-assertions` / `explain` consumers must pass.
- Spot-check `explain` output on a known assertion to ensure the new classification appears.
