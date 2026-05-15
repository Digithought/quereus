---
description: Add predicate-gated functional dependencies (conditional FDs) to the FD/EC framework so discriminated-union and soft-delete schemas can express dependencies like `{status='active'} → region`. Filter activates a guarded FD when its predicate implies the guard.
prereq: optimizer-check-derived-fds-and-domains
files:
  - packages/quereus/src/planner/nodes/plan-node.ts
  - packages/quereus/src/planner/util/fd-utils.ts
  - packages/quereus/src/planner/nodes/filter.ts
  - packages/quereus/src/planner/nodes/join-utils.ts
  - packages/quereus/src/planner/analysis/
  - packages/quereus/test/optimizer/conditional-fds.spec.ts
  - docs/optimizer.md
---

## Problem

Real schemas constantly encode dependencies that hold *only under a predicate*:

- Soft-delete: `{deleted_at is null} → all-business-uniqueness-rules`. Without the guard, "active username" can be unique while the table allows historical duplicates.
- Discriminated union: `{type='order'} → customer_id`, `{type='quote'} → expires_at`. Each row type has its own FD set.
- Status gating: `{status='active'} → assigned_region`.

Today the FD framework can only express *unconditional* FDs. As a result, queries like `select distinct customer_id, region from t where status='active'` cannot use `{status='active'} → region` to reduce the DISTINCT to `customer_id` alone, even when the schema declares the conditional FD via a check.

This ticket builds directly on `optimizer-check-derived-fds-and-domains`: that ticket extracts unconditional FDs from checks; this ticket extends the same machinery to handle implication-form checks (`check (status <> 'active' or x = y)` ≡ `status='active' → x=y`) and threads guarded FDs through the operator pipeline.

## Architecture

### Extended FD type

Augment `FunctionalDependency` in `planner/nodes/plan-node.ts` with an optional guard:

```typescript
export interface FunctionalDependency {
  readonly determinants: readonly number[];
  readonly dependents: readonly number[];
  readonly guard?: GuardPredicate;   // new — undefined = unconditional
}

export interface GuardPredicate {
  // Conjunction of equality clauses: every clause must match for the FD to activate.
  readonly clauses: readonly GuardClause[];
}

export type GuardClause =
  | { kind: 'eq-literal'; column: number; value: SqlValue }
  | { kind: 'eq-column'; left: number; right: number }
  | { kind: 'is-null'; column: number; negated: boolean };
```

Restricting `GuardClause` to a small set of equality / is-null / negated-is-null forms keeps implication checking decidable and cheap. More expressive guards are deferred.

### Implication checker

New helper `predicateImpliesGuard(predicate, guard, ecs, bindings): boolean` in `planner/util/fd-utils.ts`. Returns true iff the filter predicate (already conjuncted into clauses) entails every guard clause, considering current ECs and constant bindings:

- `eq-literal` clause `c = v`: predicate has `c = v`, or `c ∈ ec` with another member already bound to `v`.
- `eq-column` clause `a = b`: `a` and `b` are in the same EC, or both bound to the same value.
- `is-null` / `not is-null`: predicate has the matching `is null` / `is not null`, or column is non-nullable (for `not is-null`).

Implication is conservative: when in doubt, return false (the FD stays guarded).

### Activation at Filter

In `FilterNode.computePhysical`:

1. Inherit child FDs (some may be guarded).
2. For each guarded FD, run `predicateImpliesGuard(filterPredicate, fd.guard, mergedEcs, mergedBindings)`. If true, replace with the unguarded form `{determinants → dependents}`. If false, pass through unchanged.
3. Continue with the existing `extractEqualityFds` for new FDs from the filter itself.

### Propagation through other operators

- **Join (inner)**: guarded FDs from either side survive; activation may happen against the join predicate (treat `join on` clauses the same as a filter for the merged tuple). Outer joins drop guarded FDs from the nullable side because guard satisfaction can flip on null-pad.
- **Project / Aggregate**: a guarded FD survives only if its guard's referenced columns are also preserved in the output (else the guard becomes unobservable).
- **Distinct / Alias / Window / Set / Scan**: same rules as unconditional FDs.

### Sources of guarded FDs

Two sources at this ticket's scope:

1. **Implication-form check constraints** (extends ticket #1):
   - `check (status <> 'active' or x = y)` ≡ `status='active' → x=y`. The check-extraction walker recognizes this top-level disjunction shape and emits a guarded FD.
   - `check (deleted_at is not null or unique-style invariant)` is harder; uniqueness in checks isn't expressible directly — defer to *partial unique indexes* as a separate guarded-key source (out-of-scope here).
2. **Partial unique indexes** with predicate `where p`: contribute `{p} → all-cols\key`. Quereus's partial-index syntax already exists; the indexer just needs to publish the predicate alongside the key. (Optional in this ticket — split if it grows.)

## Test outline (`test/optimizer/conditional-fds.spec.ts`)

Unit:
- `predicateImpliesGuard`: literal-eq direct match; literal-eq via EC; column-eq via EC; is-null match; conservative false on non-equality predicate; conservative false on disjunction.
- Check extraction recognizes `check (a <> 'x' or b = c)` as guarded FD `{a='x'} → (b=c)`.

End-to-end via `query_plan(?)`:
- Table with `check (status <> 'active' or assigned_region = customer_region)`:
  - `select distinct customer_region, assigned_region from t where status = 'active'` reduces DISTINCT to `customer_region` alone (because the guard activates).
  - Same query without `where status = 'active'` — DISTINCT stays on both columns.
- Soft-delete pattern with partial unique index → guarded key activates inside the predicate, deactivates outside.
- Outer-join nullable-side guarded FD dropped correctly.

## Out of scope

- Conditional INDs (`{type='order'} → customer_id ⊆ customers.id`) — interesting but a separate ticket; combine with the IND work from `optimizer-ind-existence-reasoning` only after both land.
- Multi-clause guard logic beyond conjunction-of-equalities (no OR inside guards, no inequality, no IN-list guards).
- Guard simplification under closure — initial pass uses raw guard clauses.

## TODO (carry to implement)

- Extend `FunctionalDependency` with optional `guard`.
- Define `GuardPredicate`/`GuardClause` types and place near `FunctionalDependency`.
- Implement `predicateImpliesGuard` and unit-test independently.
- Extend `extractCheckConstraints` (from ticket #1) to recognize implication-form checks.
- Wire activation into `FilterNode.computePhysical`.
- Update `propagateJoinFds` and aggregate/project propagation for guard handling.
- Tests per outline above.
- Update `docs/optimizer.md` propagation table with "guard activation" notes.
