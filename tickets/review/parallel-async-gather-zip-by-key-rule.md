description: Review the recognition rule `rule-async-gather-zip-by-key` that folds a `Project` over a chain of binary full-outer `JoinNode`s sharing a common key set into one N-ary `AsyncGatherNode(zipByKey)`. Plus the collation-agreement guard added to `AsyncGatherNode.validateZipByKey`.
files: packages/quereus/src/planner/rules/parallel/rule-async-gather-zip-by-key.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/nodes/async-gather-node.ts, packages/quereus/src/planner/optimizer-tuning.ts, packages/quereus/test/optimizer/parallel-async-gather-zip-by-key.spec.ts, packages/quereus/test/runtime/async-gather.spec.ts, docs/optimizer.md
----

## What landed

A new PostOptimization rule (`rule-async-gather-zip-by-key.ts`, priority 17,
matches `PlanNodeType.Project`) that recognizes the binary full-outer-join shape
and rewrites it to a single `AsyncGatherNode({ kind: 'zipByKey', branchKeyAttrs,
outputKeyAttrs })`. Generalizes `rule-async-gather-union-all` to the zip
combinator (study that rule + `docs/optimizer.md` § *Async gather ZIP BY KEY*
for the full contract).

**Key empirical fact that shaped the design:** binary `FULL JOIN` has **no
runtime lowering** in Quereus (`runtime/emit/join.ts` throws `FULL JOIN is not
supported yet`). So this rewrite is the *only* execution path for a full-outer
chain — there is no rule-disabled execution baseline to diff against (disabling
the rule makes the same query throw). Execution tests therefore assert exact
expected rows.

### Recognized shape (canonical, v1)

```sql
select coalesce(a.k, b.k, c.k) as k, a.av, b.bv, c.cv
  from a full outer join b on a.k = b.k
         full outer join c on a.k = c.k
```

builds as `Project[ coalesce(a.k,b.k,c.k) as k, a.av, b.bv, c.cv ]` over a
left-deep `Join(full)` chain. The matcher requires, in order:

1. `ProjectNode` whose `source` is `JoinNode(joinType='full')`.
2. The full-join chain flattens to ≥ `minBranches` branches; each `ON` is a pure
   AND-of-column-ref-equalities (residual / non-equi conjunct → block).
3. Equalities partition into K key positions (union-find); **every branch
   contributes exactly one column to every position** (shared-key precondition).
4. Projection list is exactly canonical: K `coalesce(group)` calls first (define
   key order), then bare refs to every non-key column of branch 0, 1, … in
   branch + column order. This matches the emitter's row layout
   (`[K key cells][branch0 non-key]…`), so the gather replaces the Project with
   no reordering wrapper.

### Gates (block → leave as JoinNode, which then errors at emit)

- `concurrencySafe === true` on every branch.
- Every branch uncorrelated (`isCorrelatedSubquery` false).
- `max(expectedLatencyMs across branches) ≥ gatherThresholdMs` — **inert on
  memory-vtab plans** (latency 0), preserving the local-only golden-plan
  invariant.
- **Collation agreement** per key position across branches (absent = binary).
  The runtime comparator derives from branch 0 only; a mismatch would silently
  apply branch 0's collation. Also added to `validateZipByKey` (throws) so manual
  construction is guarded.
- **Branch key-uniqueness** — some declared unique key of each branch must be
  covered by the zip key columns. The zip merges one row per key; a non-unique
  branch would diverge from a true full join's per-key product. (Added beyond the
  ticket's explicit asks — it is a genuine correctness gate, please scrutinize.)

### Provenance (Option A, per the prereq)

`branchKeyAttrs[b]` = branch b's own key attr ids (distinct per branch);
`outputKeyAttrs` = the K ids the Project minted for its `coalesce` outputs (the
gather mints these); `preserveAttributeIds` = the Project's full output list,
which equals `[minted keys] ++ [branch non-key attrs]` because the canonical
order matched. Verified provenance-clean by `validatePhysicalTree` (runs in the
full suite).

## How to validate

- `node test-runner.mjs` from `packages/quereus` — full suite, **3543 passing,
  0 failing** at handoff. `yarn typecheck` and `yarn lint` clean.
- Targeted specs:
  - `test/optimizer/parallel-async-gather-zip-by-key.spec.ts` (12 tests): folds
    2/3-branch + composite-K=2 chains; correct merge results; and the full
    no-fold matrix (local-only, threshold raised, minBranches, disabledRules,
    residual predicate, branch-absent-from-key-set, non-key-unique branch,
    non-coalesce key projection).
  - `test/runtime/async-gather.spec.ts` — added unit test for the
    `validateZipByKey` collation-mismatch throw.
- Manual sanity (rule fires + correct results) was confirmed via a scratch
  query: `coalesce(a.k,b.k,c.k)` over 3 partially-overlapping tables yields the
  expected `{1:a1,∅,c1}, {2:a2,b2,∅}, {3:∅,b3,c3}`.

## Known gaps / where to dig (tests are a floor)

1. **Canonical-order-only.** Non-canonical projection orderings (key not first,
   reordered/omitted non-key columns, extra or derived columns in the SELECT)
   are silently not recognized → the query falls through to the unsupported
   binary FULL JOIN and errors at emit. A reordering `Project` on top of the
   gather (to handle arbitrary SELECT order) is documented as future work. The
   reviewer should decide whether this fragility warrants a follow-up
   fix/backlog ticket (e.g. `select a.av, coalesce(...) k, ...` is a plausible
   user query that won't fold).
2. **Representative non-determinism under non-binary collation.** Even with the
   collation gate satisfied, the emitted merged-key value is whichever branch's
   row arrived first (non-deterministic), which can differ from `coalesce`'s
   left-to-right pick when collation-equal values are byte-distinct (e.g. `NOCASE`
   merging `'A'`/`'a'`). Harmless under the default binary collation. Not
   currently tested (no multi-collation fixture). Consider whether to forbid
   non-binary key collations entirely, or test+document the chosen value.
3. **`USING` / `NATURAL` full joins untested.** The rule keys off an explicit
   `coalesce` projection over the equated columns; whether the builder emits that
   shape for `USING(k)` is unverified.
4. **`LEFT`/`RIGHT` outer chains** deliberately out of scope (zipByKey is
   symmetric full-outer only).
5. **Within-branch duplicate keys** are guarded by the uniqueness gate at
   recognition time, but the emitter's own behavior on duplicate keys remains
   "unspecified / last-write-wins" (prereq's contract) — worth a glance to
   confirm the gate is airtight (e.g. could a branch with a covering key still
   present runtime duplicates? Not for memory-vtab PK tables, but a vtab that
   declares a key it doesn't enforce would).

## Pre-existing notes

No `tickets/.pre-existing-error.md` was written — the suite is green. The
`FULL JOIN is not supported yet` emit error is *expected* pre-existing behavior
for any full-outer query that does not match this rule's gates.
