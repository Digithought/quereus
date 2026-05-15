---
description: Extend `GuardClause` with a range variant so a partial-index predicate like `WHERE age >= 18` can be discharged by a stronger filter like `WHERE age >= 21`. Today `GuardClause` is exhaustively `eq-literal | eq-column | is-null`, so any range-style partial predicate is unrecognized and drops the whole guarded FD (see `partial-unique-extraction.ts` and the analogous CHECK guard handling).
prereq:
files:
  packages/quereus/src/planner/nodes/plan-node.ts
  packages/quereus/src/planner/util/fd-utils.ts
  packages/quereus/src/planner/analysis/partial-unique-extraction.ts
  packages/quereus/src/planner/analysis/check-extraction.ts
---

## Background

The conditional-FD pipeline (`optimizer-conditional-fds`) shipped with a closed
guard-clause vocabulary that the producer-side recognizers and the
discharge-side `predicateImpliesGuard` agreed on: `eq-literal`, `eq-column`,
`is-null`. The `fd-capitalize-on-partial-unique-indexes` ticket added a second
producer (partial UNIQUE indexes) but kept the same vocabulary, so partial
predicates like `WHERE age >= 18` or `WHERE created_at < '2025-01-01'` fail
recognition and the guarded FD is never emitted.

## Scope

- Extend `GuardClause` to include a range variant analogous to the
  `DomainConstraint` `range` kind (open/closed `min`/`max`).
- Teach the recognizer in `partial-unique-extraction.ts` (and the
  implication-form recognizer in `check-extraction.ts`) to accept
  `col >`, `col >=`, `col <`, `col <=`, and `col BETWEEN lit AND lit`.
- Teach `predicateImpliesGuard` (and helpers `projectGuard`, `shiftGuard`)
  to handle the new variant: a range conjunct in the filter discharges a
  range guard if the filter's interval is a (closed-or-open) subset of the
  guard's interval. Comparisons honor type collation / NULL semantics.
- Add unit tests under `test/optimizer/conditional-fds.spec.ts`.

## Out of scope

- Mixing range + equality on the same column in a single guard (still
  decomposes via AND — each conjunct already maps independently).
- Symbolic / parameter-bound range bounds (today's bounds are literals).

## Use cases this unlocks

- `CREATE UNIQUE INDEX ... ON t(c) WHERE created_at >= '2025-01-01'` — a
  query with `WHERE created_at >= '2025-06-01'` discharges and DISTINCT
  elimination / GROUP BY collapse / FK→PK join elimination apply.
- Implication-form CHECK shapes like `CHECK (age < 18 OR <body>)` whose
  guard is `age >= 18` become dischargeable.
