---
description: Pilot treating trivially-universal `create assertion` predicates as universally-quantified row predicates the optimizer may assume true. Hoist qualifying assertions into the same FD/domain/contradiction pipeline as table-level `check` constraints. Hard scope: assertions equivalent to a per-row check on a single base table.
prereq: optimizer-check-derived-fds-and-domains, optimizer-predicate-contradiction-detection
files:
  - packages/quereus/src/schema/manager.ts
  - packages/quereus/src/schema/assertion.ts
  - packages/quereus/src/planner/analysis/
  - packages/quereus/src/planner/nodes/table-access-nodes.ts
  - packages/quereus/test/optimizer/assertion-as-premise.spec.ts
  - docs/optimizer.md
  - docs/architecture.md
---

## Problem

Quereus has `create assertion name check (...)` for database-wide invariants enforced at commit. These assertions are pure declarative truths the engine guarantees — if they didn't hold, the transaction would have rolled back. The optimizer is allowed to assume them.

Many useful assertions are equivalent to per-row checks but are written as assertions because they post-date the table or span multiple tables. The most common shape is the universal "no row violates this":

```sql
create assertion no_negative_qty
  check (not exists (select 1 from orders where qty < 0));
```

This assertion is logically equivalent to `check (qty >= 0)` on `orders` and could feed every consumer that ticket #1 added. Today the assertion engine treats it as an opaque commit-time check; the optimizer never sees its content.

This is the genuinely Quereus-unique angle from the prior discussion: declarative invariants as optimizer premises. The pilot scope is intentionally narrow — only assertions that classify as "trivially universal" — to avoid the deep end (assertion classification, soundness against partial truths, multi-table existential rewrites).

## Architecture

### Trivially-universal classification

An assertion qualifies for hoisting iff its CHECK body, after the existing planning pipeline, has the canonical form:

```
not exists (
  <SingleTableScan T> [filter <P>]
)
```

where:
- `<SingleTableScan T>` is a single base-table reference (no joins, no subqueries, no set ops).
- `<P>` references only columns of `T` and deterministic functions thereof.

The canonical form encodes "no row of T satisfies P", which is equivalent to a `check (not P)` on T.

The classifier lives in `planner/analysis/assertion-classifier.ts`. It runs over the assertion's planned-and-optimized body (we use the same planner the assertion engine uses today) and pattern-matches against the canonical form. Any assertion not matching is left as-is for the existing commit-time enforcement; the optimizer ignores it.

### Hoisting

For each qualifying assertion:

1. Negate `P` (using existing predicate-normalizer infrastructure) → the per-row invariant.
2. Pass the negated predicate to the same `extractCheckConstraints` walker built in ticket #1 — it produces FDs, ECs, constant bindings, and domain constraints.
3. Attach the resulting properties to the target table's `TableSchema` as a *derived* check, distinguishable from declared checks (different provenance for debugging) but otherwise indistinguishable to consumers.

`TableReferenceNode.computePhysical` then surfaces these alongside the declared-check-derived properties. Ticket #4's contradiction detector picks up the new domains automatically. Ticket #3's conditional FDs likewise.

### Provenance and observability

Tag derived constraints with their source assertion name so:

- `query_plan` output shows `domainConstraint(qty >= 0, source: assertion no_negative_qty)`.
- A single debug log line per derivation under `quereus:planner:assertion` records the hoist.

### Soundness fence

Two safety rails:

1. **Re-derive on schema change.** If the assertion is dropped or modified, all derived constraints with that provenance are invalidated. Hook into `SchemaManager`'s existing change notification.
2. **Skip non-deterministic assertion bodies.** If the assertion's negated predicate references `now()`, `random()`, or any non-deterministic function, do not hoist — the per-row equivalence doesn't hold under replay.

### Interaction with assertion enforcement

This ticket does **not** change commit-time assertion enforcement. The hoisted constraints are an additive optimizer signal; the existing `DeltaExecutor`-backed enforcement remains the source of truth.

## Test outline (`test/optimizer/assertion-as-premise.spec.ts`)

Classification:
- `not exists (select 1 from t where qty < 0)` → qualifies.
- `not exists (select 1 from t where qty < 0 and status = 'a')` → qualifies (single table, predicate references only `t`).
- `not exists (select 1 from t join u on ...)` → does NOT qualify (multi-table).
- `(select count(*) from t where qty < 0) = 0` → does NOT qualify in this pilot (different syntactic shape — could be normalized later, but out-of-scope here).
- Body referencing `now()` → does NOT qualify (non-deterministic).

End-to-end via SQL logic + plan-shape:
- With `create assertion no_neg check (not exists (select 1 from orders where qty < 0))`:
  - `select * from orders where qty < 0` plans to empty (via ticket #4's contradiction detector consuming the hoisted domain).
  - `select distinct status from orders where qty = -1` plans to empty.
- Drop the assertion → the same query no longer plans to empty (re-derivation fires).
- Negative: assertion exists for table T, query is on table U → no effect.
- `query_plan` output shows `source: assertion <name>` provenance on derived constraints.

## Out of scope

- Existential assertions (`check (exists (select 1 from t where ...))` — promises a non-empty subset; could feed downstream, but rewriting consumers to use it is more invasive).
- Multi-table assertions: `not exists (select 1 from t join u on ... where ...)`. These could derive *cross-table* INDs or correlations — interesting but a separate research-y ticket.
- Aggregate-form assertions (`(select sum(qty) from t) >= 0`).
- Cost-based decision to skip hoisting when the derived constraint isn't profitable — first cut just hoists everything qualifying.
- Round-trip optimization: noticing that a hoisted check makes the original assertion's commit-time check redundant on certain change deltas. Tempting but easy to get wrong; defer.

## TODO (carry to implement)

- Implement `classifyAssertionForHoisting` in `planner/analysis/assertion-classifier.ts`.
- Implement hoist pipeline reusing `extractCheckConstraints` from ticket #1.
- Add provenance tagging to derived FDs/domains (`source?: { kind: 'assertion'; name: string }` on the relevant types — additive, optional).
- Hook schema-change invalidation in `SchemaManager`.
- Tests per outline above.
- Update `docs/architecture.md` §Constraints — note assertion hoisting and its scope.
- Update `docs/optimizer.md` with an "Assertion-derived premises" subsection.
