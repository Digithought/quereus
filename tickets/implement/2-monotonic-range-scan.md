---
description: Recognize WHERE x BETWEEN a AND b (and equivalents) over a MonotonicOn input as a range-scan access pattern; add audit/diagnostics on top of the existing constraint-extraction + advertisement plumbing
prereq: monotonic-on-characteristic, bestaccessplan-monotonic-ordering
files: packages/quereus/src/planner/analysis/constraint-extractor.ts, packages/quereus/src/planner/rules/access/rule-monotonic-range-access.ts, packages/quereus/src/planner/rules/access/rule-select-access-path.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/nodes/table-access-nodes.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/test/optimizer/monotonic-range-scan.spec.ts, packages/quereus/test/optimizer/predicate-analysis.spec.ts, docs/optimizer.md
---

## Architecture

The basic plumbing already exists:

- `extractConstraints` in `analysis/constraint-extractor.ts` already handles `BETWEEN`, all four `>{=}/<{=}` combinations, `=`, and `IN` lists. `BETWEEN` decomposes to `>=` and `<=` (lines 394–440); single binary comparisons go through `extractBinaryConstraint` (lines 301–392); `IN` lists go through `extractInConstraint` (lines 442–485).
- `rule-grow-retrieve` and `rule-select-access-path` thread these constraints into `BestAccessPlanRequest.filters` and lift the access plan's `monotonicOn` / `accessCapabilities` advertisement onto `IndexScanNode` / `IndexSeekNode` via `liftAdvertisement` in `nodes/table-access-nodes.ts`.
- The memory-table module (`vtab/memory/module.ts:buildMonotonicAdvertisement`) already advertises `monotonicOn` whenever the chosen path walks a sorted index, including PK range scans (existing test `bestaccessplan-monotonic-advertisement.spec.ts`: "PK range scan lifts strict monotonicOn on the range column").

What this ticket adds is the **explicit recognition layer** sitting on top of that plumbing:

1. A formal audit/test pass that pins down the canonical-form guarantee for every recognized predicate shape.
2. A diagnostic annotation (`rangeBoundedOn`) that names the symbolic bounds on the physical leaf so EXPLAIN plans are self-evident.
3. A defensive escalation: if a vtab advertises `MonotonicOn(x)` but declines a range constraint on `x` (`handledFilters[i] = false`), drop the advertisement so downstream rules don't make false assumptions.

The output is still a `RetrieveNode` resolved to a physical leaf — no new plan node, no new runtime path. Only the `BestAccessPlanRequest`/`Result` interaction surface and the leaf's physical-property annotations are touched.

### Recognition patterns

The rule fires on these shapes when the predicate column is the access plan's `MonotonicOn` attribute:

| SQL pattern | Bound translation |
| --- | --- |
| `x BETWEEN a AND b` | `x >= a` and `x <= b` |
| `x >= a AND x <= b` | as written |
| `x >= a AND x < b` | as written |
| `x > a AND x <= b` | as written |
| `x > a AND x < b` | as written |
| `x = c` | `x >= c` and `x <= c` (degenerate range) |
| `x IN (c1, c2, …)` over `MonotonicOn` strict | union of point ranges; lowered as a disjunction the access plan may handle, or fall back to multiple seeks |

Half-bounds (`x >= a` alone, `x < b` alone) are already first-class in the constraint extractor; the rule recognizes them and treats the open side as `(-∞, b)` or `[a, ∞)`.

### `rangeBoundedOn` diagnostic

Add a new optional field on `PhysicalProperties`:

```ts
/**
 * Symbolic range bound that downstream rules / EXPLAIN can read off. Set by
 * rule-monotonic-range-access on physical leaves whose access plan walks a
 * MonotonicOn(x) path bounded by a recognized range predicate on x. The
 * lower/upper fields are absent for unbounded sides (half-open ranges).
 *
 * Non-relational: lives on the physical leaf where the access plan was
 * resolved. Pass-through nodes do NOT propagate it.
 */
rangeBoundedOn?: {
  attrId: number;
  lower?: { op: '>=' | '>'; valueLiteral?: SqlValue };
  upper?: { op: '<=' | '<'; valueLiteral?: SqlValue };
};
```

`valueLiteral` is populated when the bound is a literal; for parameter / correlated bounds it is omitted (the bound is still recognized; only the literal display is). This keeps EXPLAIN compact (`rangeBoundedOn: { attrId: 17, lower: { op: '>=', valueLiteral: 1 }, upper: { op: '<=', valueLiteral: 4 } }`) without hauling around full ScalarPlanNode trees inside physical properties.

### Where the rule attaches

The rule operates on physical access leaves (`IndexScanNode` / `IndexSeekNode` / `SeqScanNode`) post-`rule-select-access-path`, in the **PostOptimization** phase, alongside the other monotonic-aware rules (`monotonic-merge-join`, `monotonic-limit-pushdown`).

Why post-physicalization rather than pre:
- `rule-select-access-path` has already done the BestAccessPlan call and lifted `monotonicOn` onto the leaf. The audit needs the lifted advertisement plus the `FilterInfo.constraints` to inspect what was handled.
- The defensive escalation (drop `monotonicOn` if a range constraint on `x` was declined) is rare; the leaf's `FilterInfo` already encodes which constraints made it onto the index-walking path. If the leaf has `monotonicOn[0].attrId = X` but no range/equality constraint on `X` survived in `FilterInfo`, no audit firing is needed (this is just a full monotonic scan — fine). If the leaf has `monotonicOn[0].attrId = X` AND there *is* a range constraint on `X` in `FilterInfo` (handled), set `rangeBoundedOn`. If — defensively — the original plan tree still has a `FilterNode` directly above the leaf carrying an unhandled range predicate on `X` (because the vtab declined it), drop `monotonicOn` from the leaf.

The leaf's `FilterInfo.constraints` array (an array of `{ constraint: IndexConstraint, argvIndex: number }`) is the canonical source for "what range was handled at the access path" — `IndexConstraintOp.GE/GT/LE/LT` on the relevant column index. The seek-key values live in `seekKeys` on `IndexSeekNode`; for literal seek keys we can extract `valueLiteral`.

### Composition with other rules

- `OrdinalSlice` (monotonic-limit-pushdown): inspects `physical.monotonicOn` only. Unaffected by `rangeBoundedOn` — the slice still operates on the range's emit order.
- `MonotonicMergeJoin`: inspects `physical.monotonicOn` only. Two range-bounded retrieves still merge cleanly.
- `LateralTop1Asof` / `AsofScan`: inspects `accessCapabilities.asofRight`. A range-bounded right input is fine — the cursor is restricted to the range and behaves identically.

So `rangeBoundedOn` is a pure annotation today; no other rule must read it. It exists for EXPLAIN clarity and to make later rules (range-statistic-driven costing) easier to plumb.

### Diagnostics in `query_plan()`

`physical` JSON in `query_plan()` already serializes the full `PhysicalProperties` blob via `safeJsonStringify(node.physical)` (in `func/builtins/explain.ts`). Adding `rangeBoundedOn` to the type makes it appear automatically.

A test asserts the JSON contains `"rangeBoundedOn"` and the expected attrId/op shape when the rule fires.

## Implementation notes

### Phase 1: Audit / canonical-form tests

Two paths to confirm canonical extraction in `predicate-analysis.spec.ts` (or extend `extended-constraint-pushdown.spec.ts`):

For each shape in the recognition table, write a single-statement test:
- Plan: `SELECT * FROM t WHERE <pattern>` over a memory table with a single-column PK.
- Assert: extracted constraints from the Filter predicate include the canonical bound shape.
- For `BETWEEN`: two constraints, `>=` and `<=`, both with `usable: true`, both with `targetRelation` set.
- For `x = c`: one constraint, `=`. (Equality is *not* internally rewritten to two `>=`/`<=` constraints — the access plan recognizes `=` as a degenerate range; this is handled inside the new rule, not in the extractor.)
- For `x IN (c1, c2)`: one `IN` constraint with `value: [c1, c2]`.

If any shape currently fails to produce the canonical form, fix it in `constraint-extractor.ts`. The audit pass on the existing extractor strongly suggests there are no missing shapes; any addition would be a small bug-fix change.

### Phase 2: `rule-monotonic-range-access`

Create `packages/quereus/src/planner/rules/access/rule-monotonic-range-access.ts`:

```
export function ruleMonotonicRangeAccess(node: PlanNode, _ctx: OptContext): PlanNode | null {
  // Match: physical access leaf with monotonicOn advertised.
  if (!isAccessLeaf(node)) return null;
  const monotonic = node.physical.monotonicOn;
  if (!monotonic || monotonic.length === 0) return null;
  const attrId = monotonic[0].attrId;

  // Look up the column index for that attrId via source.getAttributes().
  const colIdx = findColumnIndex(node.source, attrId);
  if (colIdx < 0) return null;

  // Inspect FilterInfo.constraints for handled range/equality on colIdx.
  // Range = GE|GT|LE|LT; equality = EQ.
  const bounds = extractRangeBounds(node.filterInfo, node.seekKeys, colIdx);
  if (!bounds.lower && !bounds.upper) return null;

  // Set rangeBoundedOn on the leaf. Reconstruct the leaf via withChildren()
  // is wrong (no children change); instead, the leaf's computePhysical needs
  // to read from a stored field. Add an optional `rangeBoundedOn` field to
  // IndexScanNode / IndexSeekNode / SeqScanNode that computePhysical merges
  // into the lifted advertisement.
  return cloneLeafWithRangeBound(node, { attrId, ...bounds });
}
```

Two implementation choices for storing `rangeBoundedOn` on the leaf:

**Option A (recommended)**: pass it through the constructor like `advertisement` is today. `IndexScanNode`, `IndexSeekNode`, `SeqScanNode` get an optional `rangeBoundedOn` field; `computePhysical` merges it into the lifted advertisement. The rule constructs a new leaf with the field set. This is structurally identical to how the advertisement plumbs.

**Option B**: have the rule inject the field via a dedicated `withRangeBoundedOn(...)` method. Slightly less verbose at use-site but requires more edits to the leaf classes. Pick A unless the diff is too noisy.

### Phase 2.5: Defensive `monotonicOn` drop

If the original plan tree above the leaf carries a `FilterNode` whose predicate includes a range/equality on the monotonic column (i.e., the vtab returned `handledFilters[i] = false` for the bound), the access path is *not* monotonic over the WHERE-restricted tuple stream — only over the underlying storage. Downstream rules that depend on streaming monotonic emit (asof, merge-join) would be wrong.

The rule pattern: `Filter(<predicate-over-monotonicOn-attr>) ⇣ Leaf(monotonicOn: [{attrId: X}])` — if predicate on `X` is a range, drop `monotonicOn` from the leaf (return a new leaf without the advertisement). In well-behaved modules this case never fires; the rule is purely defensive. Log the escalation at info level so it is visible in tracing.

This case is testable with a custom test vtab that intentionally declines a range on a monotonic column.

### Phase 3: Tests

`packages/quereus/test/optimizer/monotonic-range-scan.spec.ts`:

- For each recognition pattern in the table above:
  - SQL plan-shape test: `query_plan(...)` includes a physical leaf with `physical.monotonicOn` set on the expected attrId AND `physical.rangeBoundedOn` set with the expected `lower` / `upper` shape.
  - SQL result test: rows returned match the expected slice.
- Edge cases:
  - Empty range (`WHERE x > 5 AND x < 5`) → `rangeBoundedOn` set; rows returned = 0.
  - Single-element range (`WHERE x BETWEEN 3 AND 3`) → `rangeBoundedOn` set; rows = 1 (when `x = 3` exists).
  - Half-bound (`WHERE x >= 5`) → `rangeBoundedOn` set with only `lower`.
  - `IN` list of 3 values over PK → `rangeBoundedOn` *not* set (multi-IN is non-monotonic emit; the existing `buildMonotonicAdvertisement` already returns `{}` for multi-IN; the rule no-ops).
  - Single-value `IN` (`WHERE x IN (3)`) → equivalent to `=`; `rangeBoundedOn` set as a degenerate range.
- Diagnostic test: EXPLAIN's `physical` JSON for the leaf contains `"rangeBoundedOn"` with the right keys.
- Defensive test (custom vtab): vtab advertises `monotonicOn` on column X but returns `handledFilters[i] = false` for a `>=` filter on X; verify `physical.monotonicOn` is dropped from the leaf and a `FilterNode` on the range predicate sits above.
- Negative test: no range predicate (just `SELECT * FROM t`) → `monotonicOn` advertised, `rangeBoundedOn` absent.

`packages/quereus/test/logic/monotonic-range-scan.sqllogic` (optional but recommended): SQL-logic-style assertion of result correctness for each pattern, distinct from the plan-shape tests above.

### Phase 4: Docs

`docs/optimizer.md`: under the existing monotonicOn / access-plan section, add a paragraph naming `rangeBoundedOn` and pointing at this rule. Reference the SQL patterns recognized.

## TODO

### Phase 1: Audit
- Add canonical-form tests in `predicate-analysis.spec.ts` (or `extended-constraint-pushdown.spec.ts`) for each shape in the recognition table. If any shape doesn't produce the canonical form, fix it in `constraint-extractor.ts`.

### Phase 2: PhysicalProperties + leaf plumbing
- Add `rangeBoundedOn` to `PhysicalProperties` in `planner/nodes/plan-node.ts`.
- Add an optional `rangeBoundedOn` field on `IndexScanNode`, `IndexSeekNode`, `SeqScanNode` (via constructor parameter). Have `computePhysical` merge it into the returned partial.

### Phase 3: Optimizer rule
- Implement `rule-monotonic-range-access` in `planner/rules/access/`. Match physical access leaves with `physical.monotonicOn` set; extract handled range bounds from `FilterInfo.constraints` + `seekKeys`; clone the leaf with `rangeBoundedOn` set.
- Implement the defensive escalation: if a `FilterNode` directly above the leaf carries an unhandled range/equality on the monotonic column, return a new leaf with `monotonicOn` dropped.
- Register in `optimizer.ts` `PassId.PostOptimization` with `nodeType` covering all three leaf types (or use a wildcard / multi-registration if registry supports it; otherwise register once per concrete leaf type).

### Phase 4: Tests
- `packages/quereus/test/optimizer/monotonic-range-scan.spec.ts` — plan-shape, result, edge-case, diagnostic, defensive, and negative tests as specified above.
- Optional: `packages/quereus/test/logic/monotonic-range-scan.sqllogic` for result-only correctness across patterns.

### Phase 5: Docs
- `docs/optimizer.md`: section update naming the rule and the recognition patterns it surfaces.

### Validation
- `yarn workspace @quereus/quereus exec tsc --noEmit` — clean.
- `yarn workspace @quereus/quereus lint` — clean.
- `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/range-scan.log; tail -n 80 /tmp/range-scan.log` — no regressions; new tests pass.
- `yarn build` — clean monorepo build.
