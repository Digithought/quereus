---
description: Extend the guard-clause vocabulary (or pre-normalize the partial-index / CHECK-implication predicate) to recognize OR, IN-list, and NOT shapes. Today `partial-unique-extraction.ts` and `check-extraction.ts` both bail out on anything outside `=`, `==`, `IS NULL`, `IS NOT NULL` at the conjunct level, so a partial UNIQUE like `WHERE status IN ('active', 'pending')` produces no guarded FD.
prereq:
files:
  packages/quereus/src/planner/nodes/plan-node.ts
  packages/quereus/src/planner/util/fd-utils.ts
  packages/quereus/src/planner/analysis/partial-unique-extraction.ts
  packages/quereus/src/planner/analysis/check-extraction.ts
---

## Background

`GuardClause` is exhaustively `eq-literal | eq-column | is-null`. Real-world
partial indexes commonly use:

- `WHERE status IN ('active', 'pending')`
- `WHERE deleted_at IS NULL OR status = 'archived'`
- `WHERE NOT archived`

…all of which the recognizer drops on the floor today. Filter activation
also cannot prove implication of these shapes even if we did emit them.

## Approaches

Two complementary directions:

1. **Extend `GuardClause`** to include `in-list` ({ column, values }) and
   `or-of` ({ clauses[] }) variants. Recognizers emit them; discharge-side
   `predicateImpliesGuard` checks "filter pins col to a value ∈ values"
   (for IN) and "filter implies at least one of the OR clauses" (for OR).
2. **Pre-normalize predicates** via CNF / DNF before recognition so the
   existing vocabulary stretches further (`status IN ('a', 'b')` becomes
   `status = 'a' OR status = 'b'`; discharge then uses option 1's OR).

Pick whichever has the simpler implementation tax. The split between
recognizer (producer) and `predicateImpliesGuard` (consumer) must stay
consistent — every clause shape the recognizer emits must be
dischargeable, or the FD will be permanently latent.

## Use cases this unlocks

- Partial UNIQUE on multi-status workflows: `WHERE status IN ('active',
  'pending')` — a query with `WHERE status IN ('active', 'pending')` (or
  even `WHERE status = 'active'`, since that's a subset of the IN-list)
  discharges.
- NOT-form partial predicates: `WHERE NOT archived` is equivalent to
  `WHERE archived = 0` (for boolean encodings) or `WHERE archived IS
  NULL OR archived = 0` (for nullable booleans); both should discharge.

## Out of scope

- General CNF/DNF rewriting of arbitrary predicates — keep the normalizer
  narrow.
- Arithmetic-shape guards (`age * 2 > 36`).
