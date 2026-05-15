---
description: Review the optimizer-conditional-fds implementation — predicate-gated functional dependencies, CHECK implication-form extraction, and Filter-time activation.
files:
  - packages/quereus/src/planner/nodes/plan-node.ts
  - packages/quereus/src/planner/util/fd-utils.ts
  - packages/quereus/src/planner/analysis/check-extraction.ts
  - packages/quereus/src/planner/nodes/filter.ts
  - packages/quereus/test/optimizer/conditional-fds.spec.ts
  - docs/optimizer.md
---

## What landed

### Type extension (`plan-node.ts`)

- Added `guard?: GuardPredicate` to `FunctionalDependency`.
- Defined `GuardPredicate { clauses: readonly GuardClause[] }` and the
  three guard-clause shapes recognized today: `eq-literal`, `eq-column`,
  `is-null` (with `negated` flag). Anything more expressive — inequalities,
  IN-lists, NOT-wrapped CHECKs — is deferred per the ticket's out-of-scope
  list.

### FD/EC helpers (`fd-utils.ts`)

- `computeClosure` now skips any FD with `guard !== undefined`. The closure
  layer has no notion of a surrounding predicate; activation is the Filter's
  job.
- `fdsEqual` now compares guards structurally (order-insensitive on clauses,
  using `sqlValueEquals` and column-symmetric `eq-column` equality).
- `addFd` subsumption requires equal guards — two FDs with same `K → D` but
  different guards coexist.
- `projectFds` drops a guarded FD whose `guard.clauses` reference any column
  missing from the projection mapping (the guard would become unobservable
  and the FD could never re-activate downstream).
- `shiftFds` shifts guard column indices alongside determinants/dependents
  via a new `shiftGuard` helper.
- `hasAnyKey` / `hasSingletonFd` / `isAssertedKey` / `deriveKeysFromFds` all
  skip guarded FDs — a guarded FD is not a key claim.
- New `predicateImpliesGuard(predicate, guard, ecs, bindings, attrIdToIndex,
  isColumnNonNullable)` — conservative implication check. Walks the predicate
  as an AND-conjunction once to build a `PredicateFacts` index (literal-eq
  map, column-eq peer map, `is null` set, `is not null` set), then matches
  each guard clause against direct conjuncts, equivalence classes, constant
  bindings, or column-nullability metadata.
- New `stripGuard(fd)` — returns the unconditional twin for Filter activation.

### CHECK extraction (`check-extraction.ts`)

- `recognize()` now branches on `operator === 'OR'` to `handleImplication`.
- `handleImplication` flattens nested `OR` into a disjunct list, recognizes
  all-but-last disjuncts as guard negations via `recognizeNegatedGuard`
  (handles `<>` / `!=` for column-literal and column-column equality, plus
  `IS NULL` / `IS NOT NULL` unary), bails out cleanly when any disjunct
  doesn't fit. The body is recognized as a guarded equality only — no
  equivalence pairs, bindings, or domain constraints are lifted from a
  guarded body.

### Filter activation (`filter.ts`)

- `computePhysical` restructured so EC/binding merge happens **up front**.
- New module-private `activateGuardedFds` walks inherited FDs and replaces
  guarded ones with their unconditional twin when
  `predicateImpliesGuard` returns true; otherwise passes the guarded FD
  through unchanged (so a later Filter / Join can still activate it).
- `isColumnNonNullable` is sourced from `source.getAttributes()[col].type.nullable === false`.

### Propagation polish

No code changes needed beyond Phase 1 — `propagateJoinFds` already routes
through `mergeFds`, `addFd`, `shiftFds`; project/aggregate/returning all
flow through `projectFds`. With those helpers guard-aware, propagation
behaves correctly for guarded FDs:

- Inner / cross join: guarded FDs survive on both sides (right shifted),
  including guard columns.
- Outer joins: guarded FDs on the NULL-padded side are dropped along with
  that side's unconditional FDs (existing wholesale-drop behavior).
- Project / Aggregate / Returning: `projectFds`' new guard-column check
  drops guarded FDs whose guard columns vanish.

### Docs

- `docs/optimizer.md` § Functional Dependency Tracking updated with the
  extended `FunctionalDependency` shape and a new "Guarded (conditional)
  FDs" subsection that documents the implication-form CHECK shape, the
  activation rule, and the propagation behavior.

## Test coverage (`test/optimizer/conditional-fds.spec.ts`, 34 tests)

- `predicateImpliesGuard` units: eq-literal direct / via EC / via binding;
  eq-column via EC / via predicate conjunct; is-null direct; is-null negated
  via non-nullable column / via `is not null` conjunct; conservative-false
  cases including arithmetic shapes and top-level OR; conjunctive guard
  requires all clauses.
- `extractCheckConstraints` units: the four implication patterns listed in
  the ticket plus the unguarded fall-through (`status = 'active'`) and a
  non-equality body (`x > y`) that correctly produces nothing.
- `fd-utils` guarded-FD helpers: `shiftFds`, `projectFds` (drop on missing
  guard column / remap on full mapping), `stripGuard`, `addFd` keeping
  same-det FDs side-by-side when guards differ / deduping equal guarded FDs.
- End-to-end via `query_plan(...)`:
  - Table reference carries a guarded FD from the implication-form CHECK.
  - `WHERE status = 'active'` activates the guard: bi-directional unguarded
    FDs between `customer_region` and `assigned_region` appear at FILTER.
  - Without the activating predicate, no plan node exposes the body FDs
    unguarded.
  - LEFT OUTER JOIN drops right-side guarded FDs.

## Validation status

- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/quereus run test` — **3000 passing, 2 pending**.
- `yarn workspace @quereus/quereus run lint` — exit 0.

The store-backed (`test:store`) suite was not run; the ticket noted the
prereq's review already flagged pre-existing store/sample-plugin failures
unrelated to this work.

## Known gaps / follow-ups

- `predicateImpliesGuard`'s vocabulary is intentionally narrow. Inequality
  guards, range / IN-list guards, and arithmetic-shape guards are all
  conservatively rejected. Extending the vocabulary is mechanical.
- Guard infeasibility is not detected — a guard
  `[{eq-literal c 'x'}, {eq-literal c 'y'}]` is structurally retained even
  though no predicate can entail both. Out of scope per the ticket.
- No `NOT (...)`-wrapped implication form is recognized in CHECK extraction;
  users must write the OR form. Out of scope per the ticket.
- Domain constraints under guards are not lifted — see implementation note
  in the ticket. The CHECK extractor's guarded-body path emits FDs only.
- The end-to-end activation test relies on the FILTER node surviving — a
  `WHERE status = 'active'` predicate stays at the Filter rather than being
  pushed down, but the assertion is brittle if access-plan pushdown changes
  later.

## Review focus suggestions

1. **`predicateImpliesGuard` semantics**: confirm the EC / binding / nullability
   discharge paths are sound. In particular, `eq-column` via two bindings
   sharing the same parameter ref is currently treated as entailment — is
   that defensible? (A parameter is per-execution constant, so two columns
   sharing that binding value really are equal at runtime, but the test
   coverage for the parameter case is light.)
2. **Guard column lifetime through projection**: `projectFds` drops guarded
   FDs whose guard columns vanish. If a downstream consumer expected those
   FDs to be retained "in case" the activating predicate appears later, that
   path is now broken — but per the ticket's rationale, the guard becomes
   unobservable so the FD can't re-activate anyway. Worth a second look.
3. **CHECK implication recognition**: the `recognizeNegatedGuard` mapping of
   `IS NULL` ↔ `is-null negated:true` and `IS NOT NULL` ↔ `is-null
   negated:false` is the negation of the disjunct, which is the guard. Easy
   to invert by mistake — verify the eight-test matrix in the unit suite
   covers all four cases correctly.
4. **`addFd` cap with guarded FDs**: `enforceCap`'s `keyHints` filter doesn't
   distinguish guarded from unguarded FDs. A pathological CHECK could
   theoretically push the FD list over `MAX_FDS_PER_NODE = 64`; the cap
   logic falls back to "prefer key-subset FDs," which may drop guarded
   FDs first. Probably fine in practice but worth confirming.
