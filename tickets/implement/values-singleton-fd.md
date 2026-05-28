description: Single-row `VALUES (...)` does not advertise the `∅ → all_cols` singleton FD. Add a `computePhysical` override to `ValuesNode` so a ≤1-row VALUES source carries the at-most-one-row FD, enabling whole-Sort elimination, DISTINCT elimination, GROUP BY simplification, and singleton-FD join propagation over a single-row VALUES.
files: packages/quereus/src/planner/nodes/values-node.ts, packages/quereus/test/optimizer/keys-propagation.spec.ts
----

## Design

`ValuesNode` is a zero-ary relational node (`getRelations(): []`) and currently has no
`computePhysical` override, so it advertises no functional dependencies. When the VALUES
clause has `rows.length <= 1` it is provably ≤1-row and should expose the canonical
`∅ → all_cols` singleton FD — the same shape scalar aggregates emit (see
`propagateAggregateFds` in `aggregate-node.ts:39-65`) and a constant `LIMIT ≤ 1` emits
(see `LimitOffsetNode.computePhysical` in `limit-offset.ts:105-120`).

Add a `computePhysical(_children: readonly PhysicalProperties[]): Partial<PhysicalProperties>`
override on `ValuesNode`:

- Gate on `this.rows.length <= 1`. Empty VALUES (`rows.length === 0`) is also ≤1-row;
  in that case `buildOutputType` produces `columns: []`, so `singletonFd(0)` returns
  undefined and no FD is emitted — the gate is safe at both 0 and 1 rows. The
  multi-row case (`rows.length > 1`) returns no FDs (remains a bag).
- Compute `colCount = this.getAttributes().length` and call `singletonFd(colCount)`.
  Return `{ fds: [singleton] }` if the singleton is defined; otherwise an empty
  partial.
- Also set `estimatedRows: this.rows.length` so the singleton fact and the row
  estimate agree (matches the pattern `LimitOffsetNode` follows alongside its
  singleton emission).

Imports to add at the top of `values-node.ts`:
- `PhysicalProperties` from `./plan-node.js`
- `singletonFd` from `../util/fd-utils.js`

No change required to `TableLiteralNode` in the same file (separate node, separate
ticket if ever needed).

## Why the consumers Just Work

The unified read surface `keysOf` / `isUnique` (in `fd-utils.ts:763-827`) already
consults `physical.fds` via `hasSingletonFd`, and downstream rules use those helpers:

- `rule-orderby-fd-pruning` (whole-Sort elimination) reads through `isUnique` /
  `keysOf` and treats a relation with the empty key `[]` as already ordered.
- DISTINCT elimination consults the same surface.
- `propagateAggregateFds` and `propagateJoinFds` route the singleton through joins
  and group-by simplification.
- `PlanNodeCharacteristics.guaranteesUniqueRows` (in
  `framework/characteristics.ts:82-91`) reads `hasSingletonFd(node.physical.fds, …)`.

No consumer changes are expected; this is a pure source-side completeness fix.

## Tests

Add a small block under `describe('keys read surface', …)` (or near the existing
LIMIT-1 singleton tests) in `packages/quereus/test/optimizer/keys-propagation.spec.ts`.
Reuse the `physicalFor(sql, opName)` and `hasSingletonFd(fds, totalCols)` helpers
already defined in that file.

Expected behavior tests (sketch):

- **Single-row VALUES emits singleton ∅→all FD on Values physical.**
  `SELECT * FROM (VALUES (1, 2)) AS v(a, b)` — fetch the `VALUES` physical row
  and assert `hasSingletonFd(phys.fds, 2)` is true.

- **Multi-row VALUES does NOT emit singleton FD.**
  `SELECT * FROM (VALUES (1, 2), (3, 4)) AS v(a, b)` — assert no singleton FD on
  the `VALUES` physical (`hasSingletonFd(phys.fds, 2)` is false). Acts as the
  negative control proving the FD only fires at ≤1 row.

- **ORDER BY whole-Sort eliminated over a single-row VALUES.**
  `SELECT * FROM (VALUES (1, 2)) AS v(a, b) ORDER BY a` — assert the plan
  contains no `Sort` op (via the `nodeTypesOf` / `nodeTypes` helper pattern
  used elsewhere in the file). Negative control: same query over a 2-row
  VALUES must still keep the Sort.

- **DISTINCT eliminated over a single-row VALUES.**
  `SELECT DISTINCT * FROM (VALUES (1, 2)) AS v(a, b)` — assert plan contains
  no `Distinct` op. Negative control: the 2-row variant retains DISTINCT.

- **Behavioral soundness guard.** For the ORDER BY and DISTINCT cases, also
  evaluate the query and assert the row set matches the un-eliminated form
  (single row `[{ a: 1, b: 2 }]`) — guards against the rewrite producing wrong
  results.

If the VALUES physical op name differs from `'VALUES'`, locate the row via
`r.op.toUpperCase().includes('VALUES')` rather than guessing.

## TODO

- Edit `packages/quereus/src/planner/nodes/values-node.ts`:
  - add imports for `PhysicalProperties` and `singletonFd`,
  - add the `computePhysical` override on `ValuesNode` per the design above.
- Add the test cases above to `packages/quereus/test/optimizer/keys-propagation.spec.ts`.
- Run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint`.
  Confirm no pre-existing tests regress (the singleton-FD propagation should only
  add positive facts; if any test breaks because it asserted a bag where the
  source is now ≤1-row, that test was relying on the bug).
