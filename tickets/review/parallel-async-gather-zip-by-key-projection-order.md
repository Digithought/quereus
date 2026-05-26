description: Review the generalization of `rule-async-gather-zip-by-key` to recognize full-outer-on-shared-key queries with arbitrary SELECT ordering / derived scalars over the merged key, folding them to `AsyncGatherNode(zipByKey)` under a thin reordering `Project` (canonical layout keeps the no-wrapper fast path).
files: packages/quereus/src/planner/rules/parallel/rule-async-gather-zip-by-key.ts, packages/quereus/test/optimizer/parallel-async-gather-zip-by-key.spec.ts, docs/optimizer.md, packages/quereus/src/planner/nodes/async-gather-node.ts
----

## What changed

`ruleAsyncGatherZipByKey` previously recognized **only** the exact canonical
projection layout (`[K coalesce calls][branch0 non-key][branch1 non-key]…`) and
returned null for any other shape — meaning a perfectly valid full-outer query
with reordered columns hard-errored at emit (`FULL JOIN is not supported`,
because binary FULL JOIN has no runtime lowering of its own).

The rule now:

1. Runs the layout-independent gates (chain flatten, equi-only ON, shared-key
   groups, concurrency-safe, uncorrelated, latency, collation-agreement,
   key-uniqueness) **once, up front** — moved ahead of projection matching.
2. **Fast path unchanged:** if the projection is exactly canonical
   (`matchCanonicalProjections`), the gather replaces the `Project` outright
   (no wrapper) — existing tests `countOp(PROJECT)==0` still hold.
3. **General path (new):** otherwise `buildReorderingGather` mints fresh
   `outputKeyAttrs`, builds the gather in its natural `[merged keys][branch
   non-key]` layout (passing `preserveAttributeIds` undefined so the node mints/
   forwards canonical ids itself), then wraps it in a `ProjectNode` whose
   projections reproduce the user's list. `rewriteMergedKeyRefs` walks each
   projection scalar tree and: rewrites a `coalesce(<exactly one full key
   group>)` to a bare `ColumnReferenceNode` to that group's merged-key output;
   forwards non-key refs unchanged; rebuilds surrounding pure scalar structure;
   and **blocks** (returns null → whole rewrite declines) on any branch-*key*
   reference that is not inside a recognizing full-group coalesce (the per-branch
   key is consumed into the merged key and is unavailable above the gather).
   The wrapper carries the original `Project`'s output attribute ids
   (`predefinedAttributes`), so downstream references stay valid.
4. `USING`/`NATURAL` full joins: confirmed **out of scope**. The builder stores
   their columns as `JoinNode.usingColumns` and synthesizes no explicit `ON`
   condition (`select.ts` has a literal TODO), so `collectFullJoinChain`
   (requires `node.condition`) declines them; they stay an unsupported binary
   FULL JOIN and error at emit. Pinned by a non-fold + throws-on-exec test.

Docs (`docs/optimizer.md` § *Async gather ZIP BY KEY*) updated: the
"canonical order only" limitation is lifted; a *Reordering Project wrapper*
paragraph added; *Out of scope* rewritten to explain the USING/NATURAL decline.

## Validation done

- `yarn workspace @quereus/quereus run build` — clean.
- Full suite `node test-runner.mjs` — **3581 passing, 9 pending**, no regressions.
- eslint on both changed files — clean.
- 5 new tests in the spec (all green):
  - reordered projection (key not first) — asserts gather **and** a surviving
    reordering Project + correct merge rows;
  - 3-branch reordered + **subset** of non-key columns (only `c.cv`);
  - derived scalar over merged key (`coalesce(a.k,b.k) * 10`);
  - reordered composite K=2 key (both coalesces moved, k2 before k1);
  - `USING(k)` full join does NOT fold and throws on execution.

## Use cases to re-exercise / scrutinize

- The headline acceptance query:
  `select a.av, coalesce(a.k, b.k) as k, b.bv from a full outer join b on a.k = b.k`
  (and other reorderings) — folds and returns correct full-outer-merge rows.
- Subset / derived-over-merged-key projections fold and are correct.

## Known gaps / honest flags (treat tests as a floor)

- **Scalar subquery in the projection** referencing a branch key is handled by a
  *conservative* `subtreeReferencesKey` block (declines the fold), but this path
  is **untested** — no test puts a correlated/scalar subquery in the SELECT list
  of a full-outer-merge query. Worth a targeted test (both the "subquery
  references a non-key → still folds" and "references a key → blocks" cases).
- **`coalesce` with extra args** over the key (e.g. `coalesce(a.k, b.k, 0)` or
  `coalesce(a.k, b.k, c.something)`) is intentionally **not** recognized as a
  merged key — it falls through to generic recursion, hits the bare branch-key
  refs, and blocks. This is a deliberate non-goal (the rewriter can't know such
  an expression decomposes into "merged key, then literal"), but it means a user
  who writes `coalesce(a.k, b.k, 0)` gets a hard emit error rather than a fold.
  Confirm this is acceptable vs. surprising.
- **Affinity-mismatch on key positions** is *not* pre-gated in the rule (only
  collation is). Both the canonical and the new reorder paths construct the
  `AsyncGatherNode`, whose `validateZipByKey` **throws** on an affinity
  disagreement — so a mixed-affinity shared key aborts planning rather than
  declining gracefully. This is **pre-existing** behavior inherited by the new
  path, not introduced here; flagging because the reorder path widens the set of
  queries that reach construction.
- **Wrapper Project physical properties** (FD/key/ordering propagation through
  the reordering Project) are exercised only indirectly (results + node
  presence). No assertion on `query_plan` physical of the wrapper. If a
  downstream rule depends on keys surviving the wrapper, add a plan-level check.
- The merged-key `ColumnReferenceNode.columnIndex` is set to the group index
  (`gi`, = gather output position 0..K-1). Runtime resolves by `attributeId` via
  the row descriptor, so `columnIndex` is a hint only; it is accurate here but
  not load-bearing.
- Key-position ordering in the reorder path uses the `groups`-array order
  (consistent between `branchKeyAttrs`, `outputKeyAttrs`, and the rewrite's
  group lookup). The gates also use this order; it is internally self-consistent
  but differs from the canonical path's coalesce-derived order — verify nothing
  external assumes a particular key-position order out of the gather.

## Out of scope (unchanged from prior ticket)

`LEFT`/`RIGHT` outer chains (`zipByKey` is symmetric full-outer only).
