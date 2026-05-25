description: Re-enable `zipByKey` async-gather folding for full-outer chains whose key columns use a non-binary collation (e.g. NOCASE), by making the emitter's merged-key value deterministic instead of "whichever branch arrived first".
files: packages/quereus/src/runtime/emit/async-gather.ts, packages/quereus/src/planner/rules/parallel/rule-async-gather-zip-by-key.ts, packages/quereus/src/planner/nodes/async-gather-node.ts, packages/quereus/test/optimizer/parallel-async-gather-zip-by-key.spec.ts, docs/optimizer.md
----

## Problem

`rule-async-gather-zip-by-key` recognizes a `Project` over a full-outer chain on
a shared key and folds it to `AsyncGatherNode(zipByKey)`. The emitter
(`runZipByKey`) hash-merges branches into a `BTree` keyed by the key tuple. The
output row's **key cells** are taken from whichever branch *first* inserted the
entry (`tree.insert({ key: keyRow, ... })`); subsequent branches that match only
set `cells[branch]` and never update `key`.

Branch arrival order is non-deterministic (concurrent `ParallelDriver.drive`).
Under the **binary** collation this is harmless: collation-equal keys are
byte-identical, so the merged value is the same regardless of which branch won.
Under a **non-binary** collation (NOCASE, RTRIM, …) collation-equal keys can be
byte-distinct (`'A'` vs `'a'`), so:

- the emitted merged key value is non-deterministic, and
- it can disagree with `coalesce(a.k, b.k, …)`'s SQL semantics (deterministic
  left-to-right first-non-null pick).

## Current state (v1 mitigation — already landed in the review pass)

The recognition rule now **gates non-binary key collations out entirely**
(`keyCollationsAllBinary`). A full-outer chain whose key columns are non-binary
simply stays a `JoinNode(full)` and errors at emit (`FULL JOIN is not
supported`) — the pre-rule baseline. `AsyncGatherNode.validateZipByKey` still
permits *agreeing* non-binary collations for manually-constructed gathers (with
the documented non-determinism caveat), so the node contract is unchanged; only
the auto-recognition rule is stricter.

This means correct binary-collation queries still fold, and no query silently
returns wrong/non-deterministic results — but NOCASE-keyed full-outer joins
(even ones that would be correct, e.g. all key values already byte-identical)
now hard-error rather than execute.

## Desired behavior

Make `zipByKey` deterministic under any collation so the binary-only gate can be
relaxed back to the collation-*agreement* gate:

- The merged key value for a group should match `coalesce`'s contract: the
  first **branch in branch order** (not arrival order) that has a row for that
  key supplies the merged key cells. Equivalent options to consider:
  - have the emitter overwrite `entry.key` deterministically (lowest branch
    index wins), or
  - compose the output key from the surviving branch with the lowest index at
    emit time, or
  - reduce per key over the recorded `cells[]` in branch order.
- Once deterministic, restore the rule gate to "all branches agree on the key
  collation" (the comparator still derives from branch 0, which is fine when
  collations agree) and drop the binary-only restriction.

## Acceptance

- A full-outer chain on NOCASE text keys with byte-distinct collation-equal
  values across branches (`'A'` in one, `'a'` in another) folds and yields the
  same merged key value as the equivalent `coalesce` left-to-right pick, every
  run.
- The binary-only `does NOT fold … non-binary collation` test in
  `parallel-async-gather-zip-by-key.spec.ts` is replaced by a folds-and-correct
  test; the binary sanity test stays green.
- `docs/optimizer.md` § *Async gather ZIP BY KEY* updated to describe the
  agreement gate (not binary-only) and the deterministic merge.
