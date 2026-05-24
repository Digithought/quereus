description: Recognition rule that folds a chain of binary `JoinNode(joinType='full')` full-outer-joins sharing a common key column set (rooted under a `Project`) into a single N-ary `AsyncGatherNode({ kind: 'zipByKey', keyAttrs })`. Generalizes the existing `rule-async-gather-union-all` pattern to the zip combinator.
prereq: parallel-async-gather-zip-by-key-provenance
files: packages/quereus/src/planner/rules/parallel/rule-async-gather-union-all.ts, packages/quereus/src/planner/nodes/async-gather-node.ts, packages/quereus/src/planner/nodes/join-node.ts
----

## Use case

`users FULL OUTER JOIN orders FULL OUTER JOIN reviews ON user_id` is awkward as a
left-deep tree of binary full-outer joins (O(N²) null-padding work, worse FD
inference) but natural as one N-ary `zipByKey`. Once the `zipByKey` combinator
and its manual-construction path have landed and been exercised
(`parallel-async-gather-zip-by-key`), add the optimizer rule that recognizes the
binary-join shape and rewrites it.

## What it should recognize

- A chain (any nesting) of `JoinNode(joinType='full')` where every join's
  `ON` condition equates the **same** key column set across all participating
  relations (`a.k = b.k`, `b.k = c.k`, …), rooted under the `Project` that
  surfaces those equated columns as a single output attribute per key column.
- All flattened leaf relations must be uncorrelated (no lateral dependency
  between branches) — the same precondition `AsyncGatherNode` requires.

## What it produces

A single `AsyncGatherNode({ kind: 'zipByKey', keyAttrs }, concurrencyCap, preserveAttributeIds)`
whose key representation is **whatever `parallel-async-gather-zip-by-key-provenance`
settles on** (see prereq). The original "shared key attribute ID across branches"
contract is *invalid*: two uncorrelated branches both originating the same key id
trip the attribute-provenance validator, so the prereq replaces that contract
(most likely with per-branch key refs + a gather-minted output key id). Do not
build this rule against the shared-ID assumption — revisit this section after the
prereq lands. `preserveAttributeIds` is still the recognized subtree's output
attribute list so downstream references continue to resolve.

## Notes / open questions to resolve at plan/fix time

- Gating: same `concurrencySafe` + `expectedLatencyMs >= gatherThresholdMs` gates
  as `rule-async-gather-union-all` (study that rule as the template).
- Idempotence: after rewrite the root is an `AsyncGatherNode`, so re-firing
  rejects — confirm with a golden-plan test.
- Flattening order and how to detect "shared key set" across a heterogeneous
  full-outer chain (joins may carry extra non-key residual predicates — those
  block the rewrite or must be lifted to a post-filter).
- Whether to also recognize `LEFT`/`RIGHT` outer chains (probably not for v1 —
  zipByKey is symmetric full-outer only).
