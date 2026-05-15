---
description: Producer-only addition to the conditional-FD pipeline: partial UNIQUE indexes (`CREATE UNIQUE INDEX (K) WHERE P`) now emit a guarded FD `K → others | P` on the table reference, mirroring the implication-form CHECK pathway. Filter activation discharges the guard when a surrounding predicate entails every conjunct of `P`, making `K` an unconditional key downstream.
prereq:
files:
  packages/quereus/src/planner/analysis/predicate-shape.ts                 # NEW — shared AST shape helpers
  packages/quereus/src/planner/analysis/partial-unique-extraction.ts       # NEW — producer
  packages/quereus/src/planner/analysis/check-extraction.ts                # imports from predicate-shape
  packages/quereus/src/planner/nodes/reference.ts                          # wires the producer into TableReferenceNode.computePhysical
  packages/quereus/src/planner/type-utils.ts                               # comment pointer to the new path
  packages/quereus/test/optimizer/conditional-fds.spec.ts                  # unit tests + end-to-end discharge tests
  packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic              # correctness section 7
  docs/optimizer.md                                                        # documents the new producer alongside the CHECK case
---

## What changed

1. **New shared module `analysis/predicate-shape.ts`** — factored from
   `check-extraction.ts`: `columnIndexFromExpr`, `literalValue`,
   `collectColumnNames`. Both extractors now import from here.
2. **New `analysis/partial-unique-extraction.ts`** —
   `extractPartialUniqueGuardedFds(tableSchema)` (plus a per-schema
   `WeakMap` cache via `getPartialUniqueGuardedFds`). For every
   `uc` in `tableSchema.uniqueConstraints` with `uc.predicate !== undefined`:
   - **NOT-NULL gate**: every UC column must be declared NOT NULL.
     Otherwise skipped (matches the unconditional UC path).
   - **AND-flatten** `uc.predicate`; recognize each conjunct as one of
     `eq-literal | eq-column | is-null` (positive form — distinct from
     `check-extraction`'s *negated* recognizer).
   - Emits `FunctionalDependency { determinants: K, dependents: others, guard }`.
     If **any** conjunct fails recognition, the whole FD is dropped
     (soundness — a partial guard would falsely activate over rows the
     unrecognized conjunct excludes).
3. **`TableReferenceNode.computePhysical`** calls the producer after the
   CHECK-extraction merge and folds the result via `addFd`. `addFd`
   already keeps guarded FDs side-by-side with unconditional twins, so
   no de-dup gymnastics.
4. **No changes to consumers.** Filter activation, projection through
   guarded FDs, outer-join guard-drop, and every closure-/key-query
   helper already handle guarded FDs as designed by
   `optimizer-conditional-fds`. The producer is plug-in.
5. **Soundness pin** in `relationTypeFromTableSchema` left intact;
   updated only the explanatory comment to point at the new producer.

## Behaviour delta

For a table `t (id PK, c text NOT NULL, status text NOT NULL, …)` with
`CREATE UNIQUE INDEX (c) WHERE status = 'active'`:

- Without filter: `physical.fds` on the `TABLEREF` includes a guarded FD
  `c → (id, status, …) | status='active'`.
- With `WHERE status = 'active'` (or any superset / EC variant) above:
  the Filter strips the guard, and downstream operators see `c` as a
  key. Queries that explicitly project all columns then see `c` as an
  unconditional key on the Filter's output (verified by unit tests
  in `conditional-fds.spec.ts`). Queries that *project* down to just
  `c` lose the FD at `ProjectNode.projectFds` because no dependents
  survive — this is a pre-existing limitation noted in
  `cache-rules.spec.ts` and outside the scope of this ticket.
- With a mismatched filter (e.g. `WHERE status = 'inactive'`) the
  guarded FD survives but does not activate; correctness is preserved.

## Use cases unlocked (verified by tests)

- **Producer present**: `physical.fds` on the table reference includes
  a guarded FD whose guard's clauses mirror `P`'s AND-decomposition.
- **Direct equality discharge**: `WHERE status = 'active'` activates
  the guard; the unconditional `c → others` is visible on the Filter.
- **Operand-flipped discharge**: `WHERE 'active' = status` discharges
  too (the EC layer normalizes operand order in
  `buildPredicateFacts`).
- **Filter superset**: `WHERE status = 'active' AND amt > 5` discharges
  — extra unrecognized conjuncts in the filter are harmless to
  entailment (only every guard clause needs a corresponding fact).
- **Multi-conjunct guard**: `(c) WHERE status='active' AND region='us'`
  requires *both* conjuncts in the filter; a partial entailment leaves
  the guarded FD in place (unactivated).
- **Wrong literal**: `WHERE status = 'inactive'` does NOT activate.
- **Nullable UC column**: NOT-NULL gate suppresses the FD entirely;
  even an equivalent filter does nothing.

## Out of scope (filed as backlog)

- `tickets/backlog/fd-guard-range-subsumption.md` — range variant
  (`age >= 21` discharges `age >= 18`).
- `tickets/backlog/fd-guard-isnotnull-relaxes-notnull-gate.md` — lift
  the NOT-NULL gate when the partial predicate's `IS NOT NULL`
  conjuncts cover the UC columns.
- `tickets/backlog/fd-guard-or-in-not-shapes.md` — OR / IN-list / NOT
  shapes in the partial predicate.

## Known gaps for the reviewer

- **DISTINCT-elimination over single-column projection**: with my changes,
  the *activated* FD `c → others` is correct on the Filter. But
  `select distinct c from t where status='active'` projects down to
  `{c}` only, at which point `projectFds` drops the FD entirely (no
  surviving dependents), and DISTINCT elimination never sees a key
  proof. This is a **pre-existing limitation** acknowledged in
  `cache-rules.spec.ts:69-76` for full UNIQUE constraints whose
  uniqueness is FD-derived rather than schema-declared via
  `RelationType.keys`. A follow-up that has `ProjectNode` re-emit
  projected keys derived from FDs (via `deriveKeysFromFds`) would
  unlock DISTINCT-elimination on projected partial-UC keys, but
  that's out of scope. The sqllogic tests in section 7 of
  `10.5.1-partial-indexes.sqllogic` reflect this: they pin
  correctness, not plan shape. Plan-shape verification of the
  discharge happens in `conditional-fds.spec.ts` where the Filter's
  physical FDs can be inspected directly.
- **`get`-vs-`extract` naming**: I exported both
  `getPartialUniqueGuardedFds` (cached) and
  `extractPartialUniqueGuardedFds` (uncached) — the unit tests import
  the latter to avoid sharing cache state across cases. Mirrors
  `getCheckExtraction` / `extractCheckConstraints`.

## Verification

- `yarn workspace @quereus/quereus run lint` ⇒ clean (exit 0).
- `yarn workspace @quereus/quereus run test` ⇒ 3021 passing, 2 pending,
  0 failing. Includes 11 new `extractPartialUniqueGuardedFds` unit
  tests, 7 new `Partial UNIQUE → guarded FD` end-to-end tests, and
  the updated `10.5.1-partial-indexes.sqllogic` section 7.
- `yarn test:store` not run (LevelDB path; nothing in this change
  touches the store layer — only planner analysis on `TableSchema`).

## Things to review carefully

- **Soundness of the recognizer's failure mode** in
  `partial-unique-extraction.ts:recognizeGuardClauses`: any
  unrecognized conjunct must drop the whole FD. I implemented this
  by returning `undefined` from the helper and bailing out — confirm
  this propagates correctly.
- **Cache key** (`WeakMap<TableSchema, …>`) — invalidates correctly
  when the schema manager swaps the `TableSchema` reference on
  ALTER / CREATE INDEX / DROP INDEX. The existing CHECK cache uses
  the same pattern, so the same property holds.
- **NOT-NULL gate** rejects composite UCs where *any* column is
  nullable; review the implementation
  (`uc.columns.every(idx => tableSchema.columns[idx]?.notNull)`).
- **End-to-end tests under `Partial UNIQUE → guarded FD`** in
  `conditional-fds.spec.ts` — these inspect `physical.fds` directly
  through the `query_plan(?)` TVF, so they are sensitive to operator
  naming (`TABLEREF`, `FILTER`). If we rename operators, these
  tests need a follow-up.
