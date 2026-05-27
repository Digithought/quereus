description: `LimitOffsetNode.computePhysical` passes source FDs through unchanged and never emits the singleton `∅ → all_cols` FD for `LIMIT 1` (nor for a constant `LIMIT n` resolvable to ≤1). A `LIMIT 1` relation is provably ≤1-row and should advertise the empty key like a scalar aggregate does, so downstream DISTINCT/ORDER BY/GROUP BY/join key reasoning can use it.
files: packages/quereus/src/planner/nodes/limit-offset.ts, packages/quereus/src/planner/util/fd-utils.ts (singletonFd helper), packages/quereus/test/optimizer/keys-propagation.spec.ts
----

## Problem

`LimitOffsetNode.computePhysical` (≈ lines 71–85) returns:

```ts
fds: sourcePhysical?.fds,
equivClasses: sourcePhysical?.equivClasses,
constantBindings: sourcePhysical?.constantBindings,
domainConstraints: sourcePhysical?.domainConstraints,
```

i.e. source FDs pass through unchanged. For `LIMIT 1` (or a constant `LIMIT n` that
resolves to `n <= 1`) the output is provably ≤1-row, but no `∅ → all_cols` singleton FD
is added. So a `LIMIT 1` relation does **not** advertise the empty key, and the
empty-key-aware machinery added in `empty-key-join-coverage` (join coverage, DISTINCT
elimination via `keysOf`, ORDER-BY trailing-key pruning, GROUP-BY simplification) cannot
fire over a `LIMIT 1` source.

The `empty-key-join-coverage` implementation deliberately avoided relying on `LIMIT 1`
in its tests for exactly this reason — the gap was acknowledged and deferred here.

## Expected

When `limit` is a constant evaluating to `<= 1` (and not gated off by a non-trivial
`offset` in a way that changes the ≤1-row fact — `OFFSET k LIMIT 1` is still ≤1-row),
emit the singleton FD via `singletonFd(columnCount)` (see `fd-utils.ts`) merged onto the
passed-through source FDs. `LIMIT 0` is ≤1-row too (it is exactly-zero-row, a subset of
≤1-row) and may emit the same FD soundly.

`estimatedRows` should also reflect the constant limit (currently hard-codes
`Math.min(sourceRows, 100)` for any non-undefined limit — a separate but adjacent
inaccuracy worth fixing in the same pass).

## Constraints / soundness

- Only emit when the limit is a **compile-time constant** ≤ 1 (LiteralNode /
  resolvable parameter). A parameterized/expression limit is not known ≤1-row at plan
  time — leave the passthrough behavior.
- The empty key subsumes all source keys, so merging the singleton FD is sound and
  strictly more informative; `keysOf`/`isUnique` already normalize the rest.

## Acceptance

- A `SELECT * FROM t LIMIT 1` relation reports `hasSingletonFd(...) === true` on its
  physical FDs.
- `SELECT DISTINCT * FROM t LIMIT 1` eliminates the DISTINCT.
- A join with a `LIMIT 1` side preserves the other side's keys (mirrors the
  scalar-aggregate cases in `keys-propagation.spec.ts`).
