---
description: Review parallel-execution rules now consult `PlanNodeCharacteristics.isConcurrencySafe` (the connection-lock side-effect gate) and refuse to fold/fork/prefetch when any participating branch carries a write.
prereq: query-expr-side-effect-audit
files:
  - packages/quereus/src/planner/framework/characteristics.ts
  - packages/quereus/src/planner/rules/parallel/rule-async-gather-union-all.ts
  - packages/quereus/src/planner/rules/parallel/rule-async-gather-zip-by-key.ts
  - packages/quereus/src/planner/rules/parallel/rule-eager-prefetch-probe.ts
  - packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts
  - packages/quereus/src/planner/rules/join/rule-fanout-batched-outer.ts
  - packages/quereus/test/optimizer/parallel-side-effect-refusal.spec.ts
  - docs/optimizer.md
  - docs/runtime.md
---

## Summary

This ticket landed the connection-lock correctness gate that pairs with
`dml-in-expression-position`. Every parallel-recognition rule now consults a
single shared predicate, `PlanNodeCharacteristics.isConcurrencySafe`, before
folding / forking / prefetching, and refuses (leaves the serial plan in
place) when any participating branch carries a write.

## What changed

**New predicate.** `PlanNodeCharacteristics.isConcurrencySafe(node: PlanNode): boolean`
in `packages/quereus/src/planner/framework/characteristics.ts:46-69`. Returns
`!subtreeHasSideEffects(node)`. The doc comment spells out:

- This is the **side-effect** gate the connection lock requires.
- The module-level concurrency contract (`physical.concurrencySafe`) is a
  separate gate, enforced alongside.
- When a `'fully-reentrant'` module ships, this predicate can be refined to
  permit concurrent impure execution on it.

**Five rules now route through it** (replacing direct
`subtreeHasSideEffects` calls — same behavior, single source of truth, more
readable rule code):

- `rule-async-gather-union-all.ts:74` — every branch must be
  `isConcurrencySafe`; one impure branch aborts the gather rewrite.
- `rule-async-gather-zip-by-key.ts:173` — every branch must be
  `isConcurrencySafe`.
- `rule-eager-prefetch-probe.ts:69-71` — probe AND build (the right side)
  must be `isConcurrencySafe`.
- `rule-fanout-lookup-join.ts:229-235` — outer subtree AND every spine /
  subquery branch must be `isConcurrencySafe`.
- `rule-fanout-batched-outer.ts:135-138` — outer AND every branch must be
  `isConcurrencySafe` (the batched outer pump overlaps cross-row writes too).

## Tests added

`packages/quereus/test/optimizer/parallel-side-effect-refusal.spec.ts` (10
tests, all passing):

- **Predicate unit tests (4):** pure subtree → safe; root write → unsafe;
  deep descendant write → unsafe; predicate is the negation of
  `subtreeHasSideEffects` (pins the contract).
- **`AsyncGather(unionAll)` SQL-level (4):**
  - Positive control: pure 3-branch hi-latency unionAll → rewrites to gather.
  - Negative: same shape with one branch as `select * from (insert ... returning ...)` → does NOT fold, INSERT survives in the plan.
  - End-to-end: serial plan with DML branch produces correct rows (5 — 4 reads + 1 inserted row) AND the write fires exactly once (`select count(*)` against the log table returns 1).
  - Tuning: lowering `gatherThresholdMs` to 0 does not relax the refusal (proves the side-effect gate is independent of the cost gate).
- **`EagerPrefetch` SQL-level (2):**
  - Negative: probe is `(insert ... returning ...)` → no EagerPrefetch wrap.
  - End-to-end: the DML probe yields correct rows AND fires exactly once.

## Validation run

- `yarn workspace @quereus/quereus run lint` — clean, exit 0.
- `yarn workspace @quereus/quereus run test` — 3670 passing, 9 pending, exit 0.
- `yarn test` (root, full monorepo) — all packages green.

## Docs updated

- `docs/optimizer.md` § "Parallel-track side-effect refusal" added after the
  audit-discipline section. Spells out the uniform refusal pattern across the
  five rules and points readers at `isConcurrencySafe`.
- `docs/runtime.md` § "Connection-lock contract under impure subtrees" added
  inside the parallel-runtime fork-contract section. Explains why
  `acquireConnectionLock` is a read-only serialization (it does NOT make
  writes reentrant), so the optimizer must refuse rather than rely on the
  runtime to serialize.

## Known gaps for the reviewer

The reviewer should treat this implementation as a floor, not a finish
line. Specific places worth a second look:

1. **No direct test of `rule-fanout-lookup-join` / `rule-fanout-batched-outer` refusal.**
   These rules need a FK→PK spine shape that's awkward to construct with DML
   in the outer or in a lookup branch (lookups must be base-table references
   for FK alignment to register; DML in the outer can't be wrapped as a
   subquery without losing the FK declarations). The spec covers them via:
   - The `isConcurrencySafe` predicate unit tests (the shared contract).
   - The `AsyncGather` and `EagerPrefetch` integration tests (proof the
     predicate is wired through to two real rules).
   - The existing `side-effect-audit.spec.ts` cross-rule discipline tests.
   A direct fan-out negative test would either need (a) a hand-built
   `FanOutBranchSpec` tree fed straight to the rule, similar to
   `parallel-eager-prefetch-probe.spec.ts:317+`'s manual-construction tests,
   or (b) a synthetic vtab module that mints concurrency-unsafe-by-other-means
   branches. Worth adding if the reviewer thinks the shared-predicate
   argument is too indirect — but the prior `subtreeHasSideEffects` discipline
   on these rules was untested too and survived ticket 2.

2. **`ZipByKey` recognition has no negative test.** Same reason — the rule
   needs a full-N-way outer-join shape, and the recognition rule itself is
   not yet wired (see the note in `docs/runtime.md` § AsyncGatherNode → "the
   `zipByKey` combinator … is implemented as a manual-construction node; its
   recognition rule is deferred"). When that recognition rule lands, the
   refusal test should land with it.

3. **End-to-end DML-on-parallel-candidate execution.** The two end-to-end
   tests assert exactly-once writes via `select count(*)`. They do NOT
   directly assert "no concurrent execution on the same connection" — they
   assert the *symptom* (correct row count + correct results) the violation
   would have produced. If the reviewer wants a stronger guarantee, a
   tracer-based test that asserts no in-flight overlap between DML branches
   and sibling reads on the same `activeConnection` would close that gap;
   the existing tracer infrastructure under `packages/quereus/test/runtime/`
   has the primitives.

4. **The predicate's name vs. its current semantics.** `isConcurrencySafe`
   today gates only side effects; the module-level concurrency contract
   stays as `physical.concurrencySafe`. The doc comment is explicit, but a
   reviewer reading rule code might briefly wonder why two gates exist
   side-by-side. The ticket description names them as separate concerns
   ("the side-effect gate that pairs with [the module-level gate]"); the
   naming reflects that intent — but if the reviewer prefers
   `isSideEffectFree` or splitting into two predicates with distinct names,
   that's a name-only refactor.

5. **Resume note in the ticket file.** The implement stage was resumed after
   a prior timeout. The first run did the source refactor (predicate +
   five rule sites + docstrings); this run added the tests, the docs
   sections, and verified lint + tests. No source changes from the prior
   run were undone or rewritten.

## How to test manually

Drop into a Quereus REPL or sql logic harness:

```sql
create table hi_a (id integer primary key, v integer) using hi_lat_memory;
create table hi_b (id integer primary key, v integer) using hi_lat_memory;
create table hi_c (id integer primary key, v integer) using hi_lat_memory;
create table log_t (id integer primary key, v integer) using hi_lat_memory;
insert into hi_a values (1, 10);
insert into hi_b values (2, 20);
insert into hi_c values (3, 30);

-- Pure: rewrites to AsyncGather(unionAll). Confirm with query_plan().
select * from query_plan('
  select id, v from hi_a
  union all select id, v from hi_b
  union all select id, v from hi_c');
-- → contains ASYNCGATHER

-- Impure: same shape, one branch has DML. Must NOT fold.
select * from query_plan('
  select id, v from hi_a
  union all select id, v from (insert into log_t values (99, 99) returning id, v) z
  union all select id, v from hi_c');
-- → no ASYNCGATHER; INSERT visible
```

(`hi_lat_memory` is the synthetic 25 ms-latency module used in the test
fixtures — register one in code as `class extends MemoryTableModule { readonly expectedLatencyMs = 25; }`.)
