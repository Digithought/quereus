---
description: Re-open the optimization that the soundness fix closed: emit a *guarded* FD `K → all-other-cols` for every partial UNIQUE index `(K) where P`, with the guard built from `P`'s AND-conjuncts. Filter activation (already in place) discharges the guard when a surrounding predicate entails it, unlocking DISTINCT elimination, GROUP BY simplification, ORDER BY pruning, and FK→PK join elimination for queries whose WHERE clause subsumes the partial-index predicate. Every piece of the conditional-FD machinery already exists — this ticket adds the one missing producer.
prereq:
files:
  packages/quereus/src/planner/type-utils.ts
  packages/quereus/src/planner/nodes/reference.ts
  packages/quereus/src/planner/analysis/check-extraction.ts
  packages/quereus/src/planner/analysis/partial-unique-extraction.ts        # NEW
  packages/quereus/src/schema/table.ts
  packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic
  packages/quereus/test/optimizer/conditional-fds.spec.ts
  docs/optimizer.md
---

## What already exists (do NOT rebuild)

The `optimizer-conditional-fds` ticket landed a complete guarded-FD pipeline:

- `FunctionalDependency.guard?: GuardPredicate` on `plan-node.ts:46-72`.
- `GuardClause` vocabulary: `eq-literal | eq-column | is-null` (`plan-node.ts:65-72`).
- `predicateImpliesGuard` (`util/fd-utils.ts:845`) — EC-aware, binding-aware,
  NOT-NULL-aware syntactic match across AND-conjuncts. This handles **stages 1
  and 2** of the plan ticket's predicate-implication ladder out of the box.
- Filter activation (`nodes/filter.ts:200-223` — `activateGuardedFds`) strips
  the guard from any inherited guarded FD whose guard the filter's predicate
  implies. Output FDs propagate to every downstream operator as unconditional.
- `shiftFds` / `projectFds` (`util/fd-utils.ts:358, 290`) carry guards through
  joins and projections; `stripGuard` (line 395) is the activation primitive.
- Every FD consumer (`rule-distinct-elimination`, `rule-groupby-fd-simplification`,
  `rule-orderby-fd-pruning`, `rule-join-elimination`, predicate-inference)
  reads through `hasAnyKey`/`hasSingletonFd`/`isSuperkey`/`computeClosure`,
  all of which already **skip guarded FDs**. No consumer edits are needed.
- `check-extraction.ts` already has an analogous AST→GuardClause recognizer
  for the implication-form CHECK case (`recognizeNegatedGuard` line 322,
  `handleImplication` line 268). We mirror its shape, *not negated*, for the
  partial-index predicate.

The plan ticket's "data-shape sketch" question (augment FD vs. carry
`conditionalKeys` separately) is therefore moot — the project already chose
option (a) and shipped it. We just emit guarded FDs.

## The single change

`TableReferenceNode.computePhysical` (`nodes/reference.ts:82-127`) currently
seeds FDs from `relType.keys` (PK + non-partial UNIQUE) and merges CHECK-derived
FDs from `getCheckExtraction`. Add a third source: **guarded FDs from partial
UNIQUE constraints.**

Conservative behaviour today (post-soundness-fix in
`relationTypeFromTableSchema`, `type-utils.ts:43-56`): partial UCs are filtered
out of `relType.keys` so no unconditional FD is derived. Keep that filter — we
do not want a partial UC to ever appear as an unconditional key. The new
producer reads directly from `tableSchema.uniqueConstraints`, sees only the
partial ones, and emits **guarded** FDs only.

### Recognizer (new file: `planner/analysis/partial-unique-extraction.ts`)

A function `extractPartialUniqueGuardedFds(tableSchema)` that, for each
`uniqueConstraints[i]` with `predicate !== undefined`:

1. **NOT-NULL gate.** Every UC column must be declared NOT NULL on the table.
   (A nullable UC column allows multiple NULLs even within the partial scope,
   so the FD `K → others` does not hold.) Skip otherwise. Same rule
   `relationTypeFromTableSchema` applies to non-partial UCs.
2. **Predicate → guard clauses.** Walk `uc.predicate` as a flat AND-tree (the
   parser keeps it left-associative). For each conjunct, attempt to recognize
   one of the four shapes:
     - `col = literal`   → `{ kind: 'eq-literal', column, value }`
     - `literal = col`   → same, normalized
     - `col1 = col2`     → `{ kind: 'eq-column', left: col1, right: col2 }`
     - `col IS NULL`     → `{ kind: 'is-null', column, negated: false }`
     - `col IS NOT NULL` → `{ kind: 'is-null', column, negated: true }`
   `==` and `=` are interchangeable. If **any** conjunct fails recognition,
   abort the whole guard (no FD emitted). Soundness rule: every conjunct of
   `P` must be encoded as a clause, because Filter activation requires *every*
   clause to be entailed before it lifts the FD. A weaker guard would falsely
   activate over rows not covered by `P`'s unrecognized conjuncts.
3. **Emit.** Build the FD `det = K (column indices), dep = all_cols \ K,
   guard = { clauses }`. Skip if `dep` is empty (the all-columns case has no
   non-trivial encoding — already handled by `superkeyToFd`).

`columnIndexMap` is `tableSchema.columnIndexMap` (lowercase keys); shape
recognizers should mirror `check-extraction.ts`'s `columnIndexFromExpr` /
`literalValue` helpers — factor them into a shared spot in
`check-extraction.ts` (or a tiny new `analysis/predicate-shape.ts`) rather
than duplicating. The two recognizers are nearly identical; the difference is
*negation* (check-extraction recognizes negated guards; this ticket recognizes
positive guards).

### Wire-in (`nodes/reference.ts:82`)

After the CHECK merge block, call `extractPartialUniqueGuardedFds(tableSchema)`
(cache it per-schema the same way `getCheckExtraction` does — `WeakMap<TableSchema, FunctionalDependency[]>`).
For each returned FD, `fds = addFd(fds, fd)`. `addFd` already keeps guarded
FDs side-by-side with their unconditional twins (`fd-utils.ts:208-228`); no
deduplication concern.

### `type-utils.ts` — comment update only

The existing skip at line 48-56 stays as-is; just add a one-liner to the
nearby block comment pointing to `partial-unique-extraction.ts` so a reader
sees the partial-UC path is *not* dropped on the floor but instead routed
through the guarded-FD producer.

## How the discharge happens (verification, not work)

Once a guarded FD `K → others [P]` is on a `TableReferenceNode`'s
`physical.fds`, downstream effects without any new code:

- **Below a Filter that implies P** — `FilterNode.computePhysical`
  (filter.ts) calls `activateGuardedFds`, which calls `predicateImpliesGuard`
  with the filter's predicate, the source's ECs, the source's bindings, and
  the source's NOT-NULL metadata. Match → strip guard → emit unconditional
  `K → others`. Subsequent `hasAnyKey` / `isSuperkey` / closure calls see it
  as an ordinary key. `rule-distinct-elimination` eliminates the DISTINCT;
  `rule-groupby-fd-simplification` collapses the GROUP BY; etc.
- **Above an unrelated operator (no filter discharge)** — guarded FD passes
  through `shiftFds` / `projectFds` unchanged (or is dropped if a guard
  column is projected away). `hasAnyKey`/`isSuperkey` ignore it; nothing
  bad happens.
- **Above a join that brings in additional facts** — guarded FDs on either
  side propagate via `shiftFds`. A subsequent Filter (or the join's own
  predicate, where applicable) can still activate them. Already correct
  via existing machinery.

## Test plan

Section 6 of `test/logic/10.5.1-partial-indexes.sqllogic` is the
soundness-fix's regression pin. Its assertions are deliberately
**inside-the-scope-still-doesn't-eliminate** today; flip them and add
positive coverage.

### Update expectations in section 6

The cases that explicitly filter with the partial-index predicate
(`where status = 'active'`) should now show **DISTINCT eliminated** (or
GROUP BY collapsed / LEFT JOIN row-count preserved without sorting,
whichever each subtest pins). Read the file, identify each subtest, and
update the expected output (or the plan-shape assertion) to reflect the
post-activation plan. Re-confirm via `query_plan(...)` after the change.

### Add positive discharge coverage

Add new subtests (still in section 6 or a new section 7) covering:

1. **Direct match.** `select distinct c from t where status = 'active'`
   over a `(c) where status = 'active'` partial UNIQUE — DISTINCT
   eliminated. Confirm via the `query_plan(...)` shape (no `Distinct`
   node above the filter) AND via the result rows.
2. **Filter is a superset.** `select distinct c from t where status = 'active' and other_col > 5`
   — DISTINCT eliminated (the extra conjunct is harmless; every guard
   clause is still implied).
3. **EC-based discharge.** Two flavors:
   - Operand order: `where 'active' = status` — `buildPredicateFacts`
     normalizes operand order in `op === '='` / `op === '=='` (fd-utils.ts:765-779),
     so this discharges. Confirm with a plan-shape assertion.
   - Cross-column EC: filter `where status = col_alias and col_alias = 'active'`
     should discharge a guard on `status`. Already covered by
     `predicateImpliesGuard`'s EC walk.
4. **Multi-conjunct partial predicate.**
   `create unique index ... on t(c) where status = 'active' and region = 'us'`.
   - Filter `where status = 'active' and region = 'us'` discharges.
   - Filter `where status = 'active'` alone does NOT discharge (missing
     conjunct).
5. **Negative — no filter.** `select distinct c from t` — DISTINCT not
   eliminated. Already covered by the soundness-fix tests; assert it
   still holds.
6. **Negative — wrong filter.** `select distinct c from t where status = 'inactive'`
   — DISTINCT not eliminated.
7. **Negative — nullable UC column.** Schema variant with a nullable `c`:
   even with `where status = 'active'`, the guarded FD should not be
   emitted at all (NOT-NULL gate), so no discharge happens.
8. **GROUP BY analogue.** `select c, max(amt) from t where status = 'active' group by c`
   — `rule-groupby-fd-simplification` collapses the aggregate (no
   `Aggregate` node, or its grouping is empty depending on the rule's
   exact rewrite — verify via plan shape).
9. **FK→PK join elimination analogue.**
   `select a.id from a left join t on a.t_id = t.c where t.status = 'active'`
   over a partial-UNIQUE `(c) where status = 'active'` — the join is
   reducible (right side contributes no rows from outside the scope,
   and `c` is unique within it). Verify via `query_plan(...)`.
10. **ORDER BY trailing-key pruning.** `select * from t where status = 'active' order by c, x`
    — once `c` is a key under the filter, `rule-orderby-fd-pruning`
    drops trailing sort keys after `c`. Verify.

### Unit tests in `test/optimizer/conditional-fds.spec.ts`

Add a `describe('extractPartialUniqueGuardedFds', ...)` block:

- Recognizes `where status = 'active'` as a single `eq-literal` guard
  clause on the right column.
- Recognizes `where c1 = c2` as `eq-column`.
- Recognizes `where deleted_at is null` as `is-null negated:false`.
- Recognizes `where archived is not null` as `is-null negated:true`.
- Recognizes the AND of multiple shapes (returns the corresponding
  multi-clause guard).
- **Rejects** unrecognized shapes: `where age > 18`, `where status != 'x'`,
  `where status in ('a','b')`, `where status = 'a' or region = 'b'` —
  no FD emitted (returns empty array). These are tomorrow's range /
  in-list / disjunction tickets; ship without them.
- **Rejects** nullable UC columns (NOT-NULL gate).
- **Skips** if every recognized conjunct is fine but one unrecognized
  conjunct sneaks in — the whole predicate fails (soundness).

These unit tests exercise the recognizer in isolation; the sqllogic
tests above exercise the full pipeline.

## Docs

`docs/optimizer.md` § "Functional Dependency Tracking" / § "Conditional
FDs" should mention that partial UNIQUE indexes contribute guarded FDs
on a par with implication-form CHECK constraints. Update the small
sub-section on "Unique constraints" near where the soundness fix put a
caveat (line ~1261).

## Out of scope (file as backlog if not already)

- **Range subsumption** (filter `age >= 21` discharges index `age >= 18`).
  Requires extending `GuardClause` with a range variant — substantial
  surface change. The current `GuardClause` vocabulary is exhaustively
  `eq-literal | eq-column | is-null`. File a backlog ticket.
- **IS-NOT-NULL discharge for nominally-nullable UC columns.** If the
  partial predicate is `where c is not null` and `c` is nominally
  nullable, the column is effectively NOT NULL within the partial scope,
  so the UC is a real key under the guard. Today we reject this case via
  the NOT-NULL gate. A future enhancement could lift the gate when the
  predicate's `IS NOT NULL` conjuncts cover the UC columns.
- **OR / IN / NOT discharge** in the partial predicate. The recognizer
  bails on anything outside the four basic shapes. Adding OR/IN/NOT
  requires either extending `GuardClause` or pre-normalizing the
  predicate. Future tickets.
- **Multi-index intersection.** Two partial UNIQUEs whose `WHERE` jointly
  cover the table do not give an unconditional key today. Each is
  discharged independently in queries whose filter implies its specific
  predicate. Out of scope.

## TODO

- Add `partial-unique-extraction.ts` with `extractPartialUniqueGuardedFds`
  and a `WeakMap<TableSchema, FunctionalDependency[]>` cache (mirror
  `getCheckExtraction`).
- Factor the AST-shape helpers (`columnIndexFromExpr`, `literalValue`,
  `collectColumnNames`) out of `check-extraction.ts` into a shared
  `analysis/predicate-shape.ts` so the new file reuses them. Update
  `check-extraction.ts` imports.
- Wire the call into `TableReferenceNode.computePhysical` after the CHECK
  merge, using `addFd` for each returned FD.
- Add the unit tests in `test/optimizer/conditional-fds.spec.ts`.
- Update section 6 of `test/logic/10.5.1-partial-indexes.sqllogic`
  expectations and add positive-discharge subtests per the test plan.
- Update `docs/optimizer.md` to describe partial-UNIQUE-derived guarded
  FDs alongside the CHECK-implication case.
- Run `yarn workspace @quereus/quereus run lint` and `yarn workspace @quereus/quereus run test`;
  expect previously passing soundness-fix DISTINCT-not-eliminated
  assertions to need updates as called out above.
- File the three out-of-scope items above as backlog tickets if not
  already filed; the recently-added
  `tickets/backlog/fd-conditional-fd-from-partial-unique-index.md` is
  superseded by this implement ticket and should be removed in the same
  pass (its content is now obsolete — the conditional-FD machinery exists
  and this ticket is the producer).
