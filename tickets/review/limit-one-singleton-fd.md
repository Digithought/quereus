description: Review the LIMIT 1 singleton-FD emission in LimitOffsetNode.computePhysical (+ constant-limit estimatedRows), plus a correlation guard added to the join-greedy-commute rule that the new singleton FD exposed.
files: packages/quereus/src/planner/nodes/limit-offset.ts, packages/quereus/src/planner/rules/join/rule-join-greedy-commute.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/test/optimizer/keys-propagation.spec.ts, packages/quereus/test/logic/84-asof-scan.sqllogic, docs/optimizer.md
----

## What was implemented

### 1. Singleton FD + exact estimatedRows for constant LIMIT (the ticket proper)

`packages/quereus/src/planner/nodes/limit-offset.ts`:

- Added a private `constantLimit(): number | undefined` helper. Peels
  `CastNode`/`CollateNode` to a `LiteralNode` (mirrors `literalSqlValueOf` in
  `fd-utils.ts`), then `Number(value)`. Returns `undefined` for:
  parameter/expression/subquery limits, a literal `NULL` (the emitter treats
  NULL limit as `Infinity`/unbounded, so it is **not** ≤1-row), a `Promise`
  value, or any non-finite coercion.
- `estimatedRows`: when `constantLimit()` is a finite `L >= 0`, returns
  `min(sourceRows, L)` (so `LIMIT 1` ⇒ ≤1). Non-constant limit keeps the old
  `min(sourceRows, 100)` heuristic; no limit ⇒ `sourceRows`. `sourceRows ===
  undefined ⇒ undefined` preserved.
- `computePhysical`: when `constantLimit() !== undefined && <= 1` (covers
  `LIMIT 0` and `LIMIT 1`; **offset is ignored** since it only removes rows),
  builds `singletonFd(getAttributes().length)` and **merges** it onto
  `sourcePhysical?.fds ?? []` via `mergeFds` (does not replace). Guarded on
  `singletonFd` returning `undefined` for a zero-column relation. ECs /
  constantBindings / domainConstraints / ordering / monotonicOn pass through
  exactly as before.

### 2. Correlation guard in join-greedy-commute (regression the singleton FD exposed)

`packages/quereus/src/planner/rules/join/rule-join-greedy-commute.ts`:

`ruleJoinGreedyCommute` swaps inner/cross join children to put the smaller /
≤1-row side on the left (it calls `isSingleton`, which reads `hasSingletonFd`).
Once a `LIMIT 1` lateral started advertising the singleton FD, a **correlated
LATERAL** right side became a "preferred driver" and got commuted to the outer
position — but its correlated column refs (e.g. `q.ts <= t.ts`) then resolved
before the defining relation was in scope, producing the runtime error
*"No row context found for column ts"*.

Fix: bail out of the commute when **either** join input
`isCorrelatedSubquery(...)`. This is sound (correlation imposes an evaluation
order) and conservative (only forgoes an optimization). This was a **latent**
bug — a non-singleton correlated lateral with `rightRows < leftRows` could have
triggered the same swap; the singleton FD just made it reliably reproducible.

## How it was caught / why it matters

The first full-suite run failed only on `test/logic/84-asof-scan.sqllogic`
(specifically the `CROSS JOIN LATERAL ... LIMIT 1` case). Confirmed it passed on
clean HEAD, so the singleton FD caused it. Root-caused to the commute swap (the
correlated lateral ended up as the physical join's *left* input). After the
guard, the asof rewrite fires as before and the suite is green.

## Tests added (`test/optimizer/keys-propagation.spec.ts`, in the
`Empty-key (≤1-row) join coverage` describe)

- `LIMIT 1` reports the singleton `∅→all` FD on the `LIMITOFFSET` physical.
- `LIMIT 1 OFFSET 1` still reports the singleton (offset does not gate).
- `SELECT DISTINCT * FROM t LIMIT 1` eliminates the Distinct node.
- `CROSS JOIN` with a `LIMIT 1` side preserves the other side's key (`hasKeyFd`).
- negative: `LIMIT ?` does **not** report the singleton.
- correlated `CROSS JOIN LATERAL (... LIMIT 1)` returns one row per left row
  (guards the commute fix independent of the asof path).

## Validation run

- `yarn workspace @quereus/quereus run build` — clean.
- `yarn lint` (in packages/quereus) — clean.
- Full suite `yarn workspace @quereus/quereus run test` — **3629 passing, 9 pending**.
- `test:store` / `test:full` NOT run (memory-backed default only).

## Suggested review focus / known gaps

- **`Number()` coercion edge cases in `constantLimit()`.** Matches the emitter's
  `Number(limitValue)`, but worth a sanity check on odd literal types: a boolean
  literal (`Number(true) === 1`) would qualify as ≤1-row, and a string like
  `'1'` coerces to `1`. These mirror runtime behavior and are sound (≤1 row), but
  confirm they can't arise from a path where the emitter would disagree. NULL is
  explicitly excluded; negative finite literals (e.g. `LIMIT -5`) return the raw
  negative number → `<= 1` true → singleton emitted (sound: emitter floors to 0
  rows), while `estimatedRows` falls to the `min(sourceRows, 100)` branch since
  `L >= 0` is false (a cosmetic estimate quirk for a pathological input, not a
  soundness issue).
- **Commute guard breadth.** Guarding on *either* side being correlated is
  conservative. A left side correlated against the right is not a shape the
  builder produces today, so the `getLeftSource()` half of the guard is
  defensive; reviewer may decide to narrow to the right side only. I kept both
  for safety.
- **No new plan-shape (golden) test** asserts the commute is skipped — the
  coverage is behavioral (result rows) plus the asof sqllogic. If a structural
  assertion is wanted, add one against `query_plan` confirming the lateral stays
  the join's right input.
- **Other singleton-FD consumers.** The empty-key join-coverage machinery,
  DISTINCT elimination, and ORDER-BY/GROUP-BY pruning now all see a `LIMIT 1`
  source. Tests cover join coverage + DISTINCT; the ORDER-BY/GROUP-BY pruning
  interaction over a `LIMIT 1` source is exercised only indirectly via the wider
  suite — a reviewer wanting belt-and-suspenders could add a direct case.

## Docs

`docs/optimizer.md` FD-propagation table: added an explicit `LimitOffsetNode`
row documenting the constant-≤1 singleton merge, offset-not-gating, and the
`min(sourceRows, L)` estimate. The greedy-commute rule is not separately
documented there; the correlation guard is explained in a code comment.
