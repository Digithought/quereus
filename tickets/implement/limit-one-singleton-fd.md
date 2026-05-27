description: Emit the singleton `∅ → all_cols` FD from `LimitOffsetNode.computePhysical` when `LIMIT` is a compile-time-constant ≤ 1, so a `LIMIT 1` relation advertises the empty key (≤1-row) like a scalar aggregate. Also make `estimatedRows` reflect a constant limit instead of the `min(sourceRows, 100)` hard-code.
files: packages/quereus/src/planner/nodes/limit-offset.ts, packages/quereus/src/planner/util/fd-utils.ts (singletonFd, mergeFds/addFd, hasSingletonFd), packages/quereus/test/optimizer/keys-propagation.spec.ts
----

## Problem

`LimitOffsetNode.computePhysical` (packages/quereus/src/planner/nodes/limit-offset.ts:71–85)
passes source FDs through unchanged:

```ts
fds: sourcePhysical?.fds,
equivClasses: sourcePhysical?.equivClasses,
constantBindings: sourcePhysical?.constantBindings,
domainConstraints: sourcePhysical?.domainConstraints,
```

A `LIMIT 1` (or constant `LIMIT n` with `n <= 1`) relation is provably ≤1-row but never
emits the `∅ → all_cols` singleton FD. So the empty-key-aware machinery landed in
`empty-key-join-coverage` (join coverage, DISTINCT elimination via `keysOf`, ORDER-BY
trailing-key pruning, GROUP-BY simplification) cannot fire over a `LIMIT 1` source. That
gap was deliberately deferred to this ticket.

`estimatedRows` (limit-offset.ts:59–69) also hard-codes `Math.min(sourceRows, 100)` for
any non-undefined limit — an adjacent inaccuracy to fix in the same pass.

## Root cause / approach

The fix is local to `LimitOffsetNode`:

1. **Resolve a constant limit at plan time.** Only a compile-time constant is known
   ≤1-row at plan time. Recognize a numeric `LiteralNode` (peeling through
   `CastNode`/`CollateNode`, mirroring `literalSqlValueOf` in
   `planner/util/fd-utils.ts` and the literal extraction in
   `rules/retrieve/rule-grow-retrieve.ts:321`). A parameterized / expression / subquery
   limit stays on the existing pass-through path. `this.limit === undefined` (no LIMIT)
   also stays pass-through.

   Add a small private helper, e.g. `constantLimit(): number | undefined`, that returns
   the resolved numeric limit or `undefined`. `Number(value)` coercion matches the
   emitter (`runtime/emit/limit-offset.ts`), which does `Number(limitValue)` then floors
   negatives/non-finite to `0`. Treat a non-finite / non-numeric literal as `undefined`
   (not constant-known).

2. **Emit the singleton FD when the resolved constant limit `<= 1`.** `LIMIT 0`
   (exactly-zero-row) and `LIMIT 1` are both ≤1-row, so both soundly emit
   `singletonFd(columnCount)`. `columnCount = this.getAttributes().length`. Merge the
   singleton onto the passed-through source FDs via `mergeFds`/`addFd` (NOT replace) —
   the empty key subsumes all source keys, so the merge is sound and strictly more
   informative, and `keysOf`/`isUnique`/`normalizeKeys` already normalize the rest.
   Guard `singletonFd` returning `undefined` when `columnCount === 0` (zero-column
   relation — the at-most-one-row fact rides on `estimatedRows` instead; see
   `single-row.ts` and `PlanNodeCharacteristics.guaranteesUniqueRows`).

   **Offset does not gate this.** `OFFSET k LIMIT 1` is still ≤1-row — offset only
   removes rows. Ignore `this.offset` for the singleton decision.

3. **estimatedRows from the constant limit.** When a constant limit `L >= 0` is known,
   `estimatedRows = Math.min(sourceRows, L)` (so `LIMIT 1` ⇒ at most 1). `min(sourceRows, L)`
   is a sound upper bound regardless of offset (offset only reduces the count). Keep the
   `sourceRows === undefined ⇒ undefined` behavior. Non-constant limit keeps the existing
   heuristic (or `sourceRows` when no limit) — but the current `min(sourceRows, 100)`
   for a non-constant limit can stay as-is; only the constant case must become exact.

   Ensure `computePhysical` reports the same `estimatedRows` it computes (it already
   reads `this.estimatedRows`).

## Constraints / soundness

- Only emit the singleton when the limit is a **compile-time constant** ≤ 1
  (`LiteralNode`, peeled through cast/collate). Parameter / expression / subquery limits
  remain pass-through — they are not known ≤1-row at plan time.
- Merge (don't overwrite) so any source ordering/EC/binding/domain info is preserved;
  `equivClasses`, `constantBindings`, `domainConstraints`, `ordering`, `monotonicOn`
  pass through exactly as today.
- The empty key subsumes all source keys; merging the singleton FD is sound and the
  read surface already normalizes.

## Acceptance

- `SELECT * FROM t LIMIT 1` → the LimitOffset physical FDs satisfy `hasSingletonFd(fds, colCount) === true`.
- `SELECT DISTINCT * FROM t LIMIT 1` → the Distinct node is eliminated from the plan.
- A `CROSS JOIN` with a `LIMIT 1` side preserves the other side's keys (mirrors the
  scalar-aggregate / PK-constant-bound cases already in `keys-propagation.spec.ts` under
  the `Empty-key (≤1-row) join coverage` describe).
- `LIMIT 0` may emit the singleton too (sound), but the primary asserted cases are
  `LIMIT 1`.
- A parameterized `LIMIT ?` does NOT emit the singleton (negative test).
- Build + `keys-propagation.spec.ts` + the wider optimizer suite green.

## TODO

- [ ] In `limit-offset.ts`, add a private `constantLimit(): number | undefined` helper
      that peels `CastNode`/`CollateNode`, matches `LiteralNode`, and returns the numeric
      value (via `Number(...)`) when finite, else `undefined`. Import the needed scalar
      node classes.
- [ ] Rewrite `estimatedRows`: when `constantLimit()` is a finite `L >= 0`, return
      `Math.min(sourceRows, L)`; otherwise keep current behavior.
- [ ] In `computePhysical`, when `constantLimit() !== undefined && constantLimit()! <= 1`
      and `getAttributes().length > 0`, build `singletonFd(colCount)` and `mergeFds` it
      onto `sourcePhysical?.fds ?? []`; assign the merged list to `fds`. Otherwise keep
      the pass-through `fds`. Leave EC/bindings/domains/ordering/monotonicOn untouched.
- [ ] Add tests to `test/optimizer/keys-propagation.spec.ts` (reuse `setup()` / the
      `query_plan(?)` physical-reading helpers and the local `hasSingletonFd` /
      `nodeTypesOf` helpers in the `Empty-key (≤1-row) join coverage` describe):
      - `SELECT * FROM t LIMIT 1` reports the singleton FD on the LIMITOFFSET physical.
      - `SELECT DISTINCT * FROM t LIMIT 1` eliminates the Distinct node.
      - `CROSS JOIN` with a `LIMIT 1` side preserves the other side's key
        (`hasKeyFd` on the join physical).
      - negative: `SELECT * FROM t LIMIT ?` does NOT report the singleton FD.
- [ ] Run `yarn workspace @quereus/quereus run test` (stream output) and `yarn lint`;
      update `docs/optimizer.md` FD-propagation table row for LIMIT/OFFSET if it lists
      per-node behavior.
