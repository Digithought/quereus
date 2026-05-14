---
description: Generalize binding-aware delta planning so materialized views and other delta-driven features can refresh per-group using FD-determined group keys, not just per-row
prereq: fd-change-detection-classification
files:
  - packages/quereus/src/runtime/delta-executor.ts (new or existing — check during implementation)
  - packages/quereus/src/planner/analysis/binding-extractor.ts (new)
  - packages/quereus/src/core/transaction.ts
  - packages/quereus/src/schema/view.ts
  - packages/quereus/test/incremental/delta-group-key.spec.ts
  - docs/architecture.md
  - docs/optimizer.md
---

## Motivation

The assertion delta pipeline established a pattern: classify references, build parameterized variants, execute per-binding on COMMIT. The plan in `docs/optimizer.md` § "Binding-aware Delta Planning" (lines 1220–1247) explicitly calls this out as reusable for incremental view maintenance, triggers, and other change-driven features. It defines three modes — row-specific, group-specific, global — but the analysis backing them was PK-centric until the previous ticket (`fd-change-detection-classification`) lifted it to FD coverage.

This ticket builds the consumer side: a reusable delta-execution kernel that any feature can register against, with FD-aware binding key extraction. Materialized views are the motivating use case. The shape:

```sql
CREATE VIEW orders_per_customer AS
SELECT customer_id, sum(total) AS total
FROM orders
GROUP BY customer_id;

CREATE MATERIALIZED orders_per_customer;
```

When an order changes:

- The orders row's `customer_id` is the changed group key.
- The maintained view's row for that customer_id is invalidated.
- Re-evaluate just that customer's sum (a single GROUP BY restriction), update the cached view row.

Without FD-aware binding key extraction, the maintainer would have to re-evaluate the entire view. With it, the cost is O(1) per change.

The existing backlog ticket `tickets/backlog/3-incremental-delta-runtime.md` names this work. This ticket fleshes it out and lands the reusable kernel.

## Architecture

### DeltaExecutor kernel

A new runtime component that consumers register against:

```typescript
interface DeltaSubscription {
  /** Identifier for diagnostics (e.g. "view:orders_per_customer", "assertion:no_negative_balance"). */
  id: string;
  /** The base relation(s) this subscription depends on. */
  dependencies: Set<string /* tableRelationKey */>;
  /** Per-dependency: how this subscription is bound to changes. */
  bindings: Map<string /* tableRelationKey */, BindingMode>;
  /** Invoked when changes arrive. */
  apply(changes: Map<string, ChangeBatch>): Promise<void>;
}

type BindingMode =
  | { kind: 'global' }                              // re-evaluate fully
  | { kind: 'row'; keyColumns: number[] }           // per primary-key
  | { kind: 'group'; groupColumns: number[]; ... }; // per group key
```

The kernel:

- Aggregates per-transaction changes from the existing `transactionLog`.
- For each subscription whose dependencies intersect the changed tables:
  - For each dependency, look up the binding mode.
  - If `'global'` AND the dependency changed: schedule a full re-evaluation of the subscription.
  - If `'row'`: enumerate the changed PKs of the dependency, build per-row parameter bindings, invoke `apply` with the batch.
  - If `'group'`: enumerate the changed group keys (project the changed rows onto the group columns, de-duplicate), build per-group parameter bindings, invoke `apply` with the batch.
- Subscriptions can declare independent dependencies; the kernel batches their evaluation.

The existing assertion COMMIT path becomes the first consumer of this kernel.

### Binding key extraction

A new analyzer `extractBindings(plan: RelationalPlanNode): Map<relationKey, BindingMode>`:

- Reuses `analyzeRowSpecific` from the previous ticket but returns the richer `BindingMode` shape (with column lists).
- Group keys come from `RowSpecificResult.groupKeys` (set by the FD-aware classifier).
- Row keys come from `extractCoveredKeysForTable` (already exists; result has the column indices).
- The `BindingMode` for each dependent table feeds the subscription.

### Materialized view as a consumer

The `MaterializedViewSchema` (defined elsewhere, schema layer) gains:

- A `DeltaSubscription` registered at view creation time.
- The subscription's `apply` invokes a refresh kernel:
  - For `'global'` mode: re-run the view's query, replace cached rows.
  - For `'row'` mode: delete/upsert per-row in the cache; the residual query is the view's query with the row's PK as a bound parameter.
  - For `'group'` mode: delete-then-insert per group key; the residual query is the view's query restricted to that group.

### Residual construction

For each dependency, the residual query is the original view query with a `Filter` injected on the dependency's own attributes binding the changed key/group. The injection uses the same machinery as the assertion delta pipeline (`docs/optimizer.md` § "Binding-aware Delta Planning" → "Residual Construction"):

- Don't restructure joins — inject Filter on the bound relation's own attributes with `= ?` parameters.
- Preserve attribute IDs; parameter order follows key column order.
- Cache one residual per `(relationKey, keyShape)`.

### Savepoint awareness

`ChangeCapture` is already savepoint-aware in the assertion path. The DeltaExecutor inherits this — savepoint rollback clears the corresponding change layer, savepoint release merges. Materialized view refresh runs after all savepoints settle (at COMMIT), so the maintenance sees the net effect.

### Cost model

Per-group/per-row refresh is cheap only if the residual query is cheap. The DeltaExecutor checks the residual's estimated cost vs the full re-evaluation cost. If many groups changed (e.g. >50% of distinct group keys touched), fall back to global re-evaluation. Configurable threshold via `tuning.deltaPerRowFallbackRatio`.

## Use cases enabled

- Materialized views with per-group incremental refresh. Foundational for any analytical UI built on Quereus.
- Reactive signals: an application registers a subscription on a query and gets notified of which group keys changed. The kernel computes which subscriptions are touched and invokes their handlers with the binding lists.
- The assertion pipeline gets the `'group'` mode it was always supposed to have but couldn't until FD classification landed.

## Tests

- Unit test: a subscription with `BindingMode = 'row'` is invoked with the correct per-row parameter bindings on INSERT/UPDATE/DELETE.
- Unit test: a subscription with `BindingMode = 'group'` is invoked with deduplicated per-group bindings when multiple rows in the same group change.
- Unit test: subscription with `'global'` mode fires a full re-evaluation.
- Integration test: a materialized view's contents stay in sync with the base table across multi-statement transactions and savepoint rollback.
- Stress test: an assertion using `'group'` mode performs O(changed_groups) work, not O(total_groups), at COMMIT.

## Documentation

- **docs/architecture.md** — extend the assertion/constraint discussion to mention the reusable DeltaExecutor; add a brief reference to materialized views as a planned consumer.
- **docs/optimizer.md** — flesh out the "Binding-aware Delta Planning (Reusable)" section (currently lines 1220–1247, mostly aspirational) with the concrete kernel design, the BindingMode shape, and the cost-model fallback to global re-evaluation.
- Consider a new top-level doc `docs/incremental-maintenance.md` covering the DeltaExecutor architecture in depth and its relationship to assertions, materialized views, and reactive subscriptions. This is large enough to deserve its own doc; the optimizer.md section becomes a summary that points there.

## Out of scope

- Multi-table materialized views with non-trivial joins — the binding extraction works in principle, but the residual queries can become expensive. The first cut targets single-table-grouped views and FK-join views.
- Materialized view DDL syntax and storage. This ticket is the maintenance kernel; how views are declared and where their cached contents live is a separate concern handled by the broader materialized-views feature ticket.
- Cross-process reactive subscriptions (network-published change notifications). Same kernel applies in principle but transport is a separate problem.
