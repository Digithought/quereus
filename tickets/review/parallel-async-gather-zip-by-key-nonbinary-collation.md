description: Review — `zipByKey` async-gather now merges keys deterministically (lowest-indexed present branch), so the recognition rule's binary-only collation gate was relaxed to a collation-*agreement* gate. NOCASE (and other non-binary) full-outer chains fold again and match `coalesce`.
files: packages/quereus/src/runtime/emit/async-gather.ts, packages/quereus/src/planner/rules/parallel/rule-async-gather-zip-by-key.ts, packages/quereus/src/planner/nodes/async-gather-node.ts, packages/quereus/test/optimizer/parallel-async-gather-zip-by-key.spec.ts, packages/quereus/test/runtime/async-gather.spec.ts, docs/optimizer.md
----

## What changed

The v1 mitigation gated non-binary key collations out of the `zipByKey`
recognition rule entirely, because the emitter took the merged key cells from
**whichever branch arrived first** (concurrent → non-deterministic). This ticket
makes the merge deterministic and relaxes the gate back to collation *agreement*.

### Emitter (`runtime/emit/async-gather.ts`)

- New helper `composeMergedKeyCells(cells, branchKeyIndices)`: the **lowest-indexed
  present branch** supplies all K merged key cells. Both the tree-walk emit loop
  and the NULL-keyed standalone loop now call it instead of using `entry.key` /
  the arriving branch's `keyRow`.
- Rationale this is correct (matches `coalesce(b0.k, b1.k, …)`): NULL-keyed rows
  are split off separately, so for any merged group every *present* branch has
  all its key columns non-null and collation-equal to the group key. `coalesce`
  picks the first non-null per position; since the first present branch is
  non-null at *every* position, picking all key cells from the lowest-indexed
  present branch equals `coalesce`'s left-to-right pick at every position.
- The `BTree` is still keyed by the first-arrived key tuple — that only drives
  comparison, and collation-equal keys compare identical, so the merge grouping
  is unaffected. `ZipEntry.key` is retained solely as the BTree key extractor.

### Rule (`rules/parallel/rule-async-gather-zip-by-key.ts`)

- `keyCollationsAllBinary` → `keyCollationsAgree`: blocks only when a key
  position's collation **disagrees across branches** (the runtime comparator
  derives from branch 0, so disagreement is the real hazard). Non-binary but
  agreeing collations now fold. This mirrors the *agreement* invariant
  `AsyncGatherNode.validateZipByKey` enforces (which throws on a true mismatch);
  the rule checks it to decline gracefully rather than let planning throw.
- Header-comment "Binary key collation" gate rewritten to "Key collation
  agreement"; call-site comment updated.

### Tests / docs

- Replaced the binary-only `does NOT fold … non-binary collation` test with
  `folds an agreeing-NOCASE chain and merges keys deterministically (matches
  coalesce)`: NOCASE keys, byte-distinct collation-equal values across branches
  (`'A'` in `ca`, `'a'` in `cb`), plus a `cb`-only `'B'`. Asserts the merged key
  is `ca`'s `'A'` (lowest present branch == coalesce pick) and `cb`'s `'B'`,
  looped 5× to demonstrate determinism under concurrent arrival.
- Binary sanity test (`still folds when key columns are explicitly binary`) stays.
- `docs/optimizer.md` § *Async gather ZIP BY KEY*: Gates paragraph now describes
  the agreement gate + deterministic merge; the out-of-scope sentence about
  non-binary collations (and this ticket as follow-up) removed.

## Validation done

- `node packages/quereus/test-runner.mjs --grep "ruleAsyncGatherZipByKey"` — 14/14 pass.
- `node packages/quereus/test-runner.mjs --grep "AsyncGather"` — 86 pass, 1 pending (the strict-fork case, intentionally skipped).
- Full suite `node packages/quereus/test-runner.mjs` — **3575 passing, 9 pending, 0 failing** (~35s).
- `eslint` clean on both changed source files.

Note: run tests via the project's `test-runner.mjs` (uses `register.mjs`). Raw
`npx mocha` falls back to node strip-only mode, which (a) fails on TS parameter
properties in the mock helpers and (b) shares a global attr-id counter across
files, producing a spurious "originated at two distinct nodes" provenance error.
That is a runner artifact, **not** a code issue — `test-runner.mjs` is green.

## Suggested review focus / known gaps

- **Determinism argument under composite keys + partial-NULL within a present
  branch.** The correctness argument leans on "every present branch is non-null
  at every key position." That holds because any row with a NULL in *any* key
  cell is routed to the NULL-keyed standalone path (`keyRow.some(v => v === null)`).
  Worth a second look that a composite key can't sneak a present-branch row with
  a NULL component into a merged group. (Existing runtime test "composite key
  with a NULL component is treated as NULL-keyed" covers the standalone routing.)
- **No direct unit test on `composeMergedKeyCells`** — it is exercised only
  end-to-end via the optimizer NOCASE test and the existing `zipByKey runtime`
  suite. A reviewer wanting a tighter floor could add a runtime-level test that
  feeds branches in a forced arrival order and asserts the lowest-index pick.
- **`coalesce` semantics vs. always-non-null keys.** If a future change ever lets
  a present branch carry a NULL key column into a merged group, `coalesce` would
  skip it position-wise while `composeMergedKeyCells` would emit the whole row's
  (NULL-containing) key — a divergence. Currently impossible by the NULL-key
  split, but the coupling is implicit; a reviewer may want it asserted/commented
  at the split site.
- **RTRIM and other non-binary collations** are not explicitly tested (only
  NOCASE). The agreement gate and deterministic merge are collation-agnostic, so
  NOCASE coverage is representative, but a reviewer could add an RTRIM case if
  cheap.
