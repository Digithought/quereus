---
description: Public API exposing a prepared statement's change scope as a serializable data structure, plus a watcher that consumes the same data structure regardless of source
prereq: fd-property-foundation, fd-change-detection-classification, fd-view-maintenance-binding-keys
files:
  - packages/quereus/src/core/statement.ts
  - packages/quereus/src/core/database.ts
  - packages/quereus/src/planner/analysis/change-scope.ts
  - packages/quereus/src/planner/analysis/binding-extractor.ts
  - packages/quereus/src/runtime/delta-executor.ts
  - packages/quereus/src/index.ts
  - packages/quereus/test/logic/change-scope.spec.ts
  - packages/quereus/test/optimizer/change-scope-analyzer.spec.ts
  - docs/architecture.md
  - docs/optimizer.md
  - docs/usage.md
  - docs/change-scope.md
---

**Review checklist (before marking done):**
- Every doc listed in `## Documentation` below has been updated in the same change, not deferred.
- New public types (`ChangeScope`, `TableWatch`, `NonDetSource`, `Subscription`, `WatchHandler`, helpers) are re-exported from `packages/quereus/src/index.ts`.
- `docs/architecture.md` § "Key Design Decisions" mentions change-scope introspection and links to the new doc.
- Examples in `docs/usage.md` show both halves of the API in isolation (analyzer-only, watcher-only with a hand-built scope) and the combined case.
- API surface area is auditable at one glance — list the exact exports added in the implement-stage handoff summary so the review pass can scan for accidental shape drift.

## Motivation

The `DeltaExecutor` kernel from `fd-view-maintenance-binding-keys` lets internal consumers (assertion COMMIT eval, materialized-view maintenance) subscribe to base-table changes scoped by FD-derived bindings. Applications can already build the same shape of reactive feature on top of Quereus today, but they have to either:

- Watch every table their queries touch at the table grain — the "everything is dirty" approach, fine for small UIs, wasteful otherwise.
- Re-derive scoping by hand from each query's text — duplicating what the planner already computes during FD propagation and binding extraction.

Both lose the information the engine already has. The internal `extractBindings` analyzer knows that `select sum(total) from orders where customer_id = ?` is row-scoped on `customers` (via FK), group-scoped on `orders` by `customer_id`, and reads only the `total` and `customer_id` columns of `orders`. Applications building dashboards, query caches, sync layers, or sub-second UIs want this output.

The user-facing requirement, from the brainstorm that produced this ticket, is **two halves with a data contract between them**:

1. An *analyzer* on `Statement` that returns the change scope as plain data, so callers can route their own change notifications, persist the scope, send it across a network, intersect it with other scopes, or do anything else with it that working with data permits.
2. A *watcher* on `Database` that consumes a change-scope value — regardless of where it came from — and fires a callback when the database mutates in a way that intersects it. The watcher must work equally well with a freshly analyzed scope, a serialized-and-rehydrated scope, or a scope assembled by hand.

The two halves stay independently useful and independently testable.

## Architecture

### The data contract

```typescript
/** Top-level scope describing what changes could alter a query result. */
export interface ChangeScope {
  /** One entry per base table the query depends on. */
  readonly watches: ReadonlyArray<TableWatch>;
  /** Non-deterministic functions in scalar expressions — result depends on more than table state. */
  readonly nonDeterministicSources: ReadonlyArray<NonDetSource>;
  /** Parameter positions referenced inside any `values` entry but not yet bound. */
  readonly unboundParameters: ReadonlyArray<number>;
}

export interface TableWatch {
  /** Schema-qualified table name. */
  readonly table: QualifiedName;
  /** Columns whose change would (or could) affect the result. `'all'` is the conservative case. */
  readonly columns: ReadonlySet<string> | 'all';
  /** How the rows of this table are narrowed. */
  readonly scope: WatchScope;
}

export type WatchScope =
  | { readonly kind: 'full' }
  | { readonly kind: 'rows';        readonly key: string[];      readonly values: ReadonlyArray<ReadonlyArray<ScopeValue>> }
  | { readonly kind: 'groups';      readonly groupBy: string[] }
  | { readonly kind: 'rowsByGroup'; readonly groupBy: string[];  readonly values: ReadonlyArray<ReadonlyArray<ScopeValue>> };

/** A literal value or a placeholder for an as-yet-unbound parameter. */
export type ScopeValue = SqlValue | { readonly kind: 'param'; readonly index: number; readonly type: ScalarType };

export type NonDetSource =
  | { readonly kind: 'time' }                                       // now(), epoch_ms('now'), ...
  | { readonly kind: 'random' }
  | { readonly kind: 'volatileUdf'; readonly name: string }
  | { readonly kind: 'parameter'; readonly index: number };         // unbound param surfaced as a content source
```

Design properties this contract must satisfy:

- **JSON-serializable.** `ChangeScope` must round-trip through `JSON.stringify`/`parse` (using `ScopeValue` placeholders for params rather than function values). This is what enables persistence, network transport, and "scope as configuration."
- **Equality-by-value.** Two scopes describing the same constraints must be `deepEqual`. Necessary for caching and for tests.
- **Composable.** Ship helpers `unionScopes(a, b)`, `intersectScopes(a, b)`, `bindParameters(scope, params)` (resolves `ScopeValue.param` references and clears matching `unboundParameters` entries). Without these, callers re-invent set theory.
- **No nested watches.** Every table the query reads gets its own top-level `TableWatch`. If table A's row-binding values come from a subquery over table B, A is reported with `{kind: 'full'}` (or `{kind: 'groups'}` if a FD-determined group key survives), and B gets its own `TableWatch` as a normal scan. There is no recursive structure.

### Two cases that are not the same thing

The analyzer must distinguish — both internally and in tests — between two cases that are easy to conflate:

| Case | Example | Treatment |
| --- | --- | --- |
| Unbound parameter as a row-binding value | `where id = ?` | Emit `{kind: 'rows', key: ['id'], values: [[{kind:'param', index:0, type:int}]]}`. Add `0` to `unboundParameters`. Caller can pass `params` to `getChangeScope` (resolves now) or pass them later to `bindParameters` (resolves on the data). Fully precise — parameter typing/nullability already known at plan time. |
| Subquery as a row-binding source | `where id in (select id from premium_customers)` | Fall back to `{kind: 'full'}` for this watch — values depend on the subquery's current contents. The subquery's source table gets its own normal `TableWatch`. Note this explicitly in the analyzer's comments and in the doc. |

The "static-only on subquery-sourced bindings" choice is **the policy**, not an open question. Refining it (e.g., a separate scope mode for "watch rows of A whose key joins to current rows of B") may be revisited later but is out of scope here.

### Public API: analyzer half

```typescript
// in packages/quereus/src/core/statement.ts
class Statement {
  // ... existing members ...

  /**
   * Returns the change scope for this prepared statement: the set of base-table
   * changes that could alter its result. Pure with respect to database state;
   * depends only on the prepared plan and (optionally) parameter values.
   *
   * If `params` is supplied, parameter placeholders inside row-binding values
   * are resolved to literals and `unboundParameters` is filtered accordingly.
   * If `params` is omitted, the returned scope still describes the prepared
   * statement faithfully — it just contains `ScopeValue.param` placeholders.
   */
  public getChangeScope(params?: SqlParameters | SqlValue[]): ChangeScope;
}
```

Implementation lives in a new pure module `packages/quereus/src/planner/analysis/change-scope.ts`. It is built on top of `extractBindings(plan)` from the prereq ticket, plus a scalar-expression walk that collects non-deterministic function references via the existing `FunctionFlags.DETERMINISTIC` bit (anything *without* the flag becomes a `NonDetSource`).

The analyzer takes a *plan*, not a Statement. The Statement method is a thin wrapper that fetches its optimized plan, calls the analyzer, and applies `bindParameters` if `params` is provided. This keeps the analyzer testable in isolation.

### Public API: watcher half

```typescript
// in packages/quereus/src/core/database.ts
class Database {
  // ... existing members ...

  /**
   * Subscribe to changes that intersect a scope. Fires `handler` after commit
   * whenever the transaction's effects touch any watch. The scope may have come
   * from `statement.getChangeScope()`, been deserialized from elsewhere, or
   * been constructed by hand — the watcher does not care.
   */
  public watch(scope: ChangeScope, handler: WatchHandler): Subscription;
}

export interface Subscription {
  readonly id: string;
  unsubscribe(): void;
}

export interface WatchEvent {
  /** Watches from the input scope that this transaction intersected. */
  readonly matched: ReadonlyArray<MatchedWatch>;
  /** Transaction identity / sequence — useful for ordering replay. */
  readonly txnId: string;
}

export interface MatchedWatch {
  readonly watch: TableWatch;
  /** For `rows` / `rowsByGroup` watches: the specific keys/groups in this txn that hit. */
  readonly hits: ReadonlyArray<ReadonlyArray<SqlValue>>;
  /** For `groups`: the distinct group keys touched. Empty array means "table was touched but no narrowing fields apply" (full mode). */
}

export type WatchHandler = (event: WatchEvent) => void | Promise<void>;
```

Implementation: the watcher registers a `DeltaSubscription` against the existing `DeltaExecutor` kernel from `fd-view-maintenance-binding-keys`. The translation from `ChangeScope` to internal `DeltaSubscription` shape is mechanical (`TableWatch` → `BindingMode`, etc.) and lives in `delta-executor.ts` alongside the assertion/MV translations. Non-deterministic sources do not affect subscription firing — they are advisory metadata only; the watcher cannot detect wall-clock changes itself and should not pretend to.

Firing semantics:
- After-commit only. Mid-transaction changes do not fire. (Consistent with assertion COMMIT eval and MV maintenance.)
- A scope with `nonDeterministicSources.length > 0` still gets registered normally; the handler simply needs to understand that "no event" does not imply "result unchanged" for time-dependent queries. The analyzer documents this in the returned scope and in the doc.
- Empty `watches` → the subscription is still legal but will never fire; useful for tests and degenerate cases. Log a warning when this is the only thing keeping the subscription alive *and* `nonDeterministicSources` is also empty (dead subscription).

### Why these two halves stay decoupled

The data contract is the seam. Three properties that follow:

- **Inspection without commitment.** An app can call `statement.getChangeScope()` purely to introspect — no subscription registered, no kernel started. Useful for diagnostics, query catalogs, sync-protocol packet construction.
- **Subscription without inspection.** An app already in possession of a scope value (loaded from disk, received over the wire, computed manually) can call `database.watch(scope, ...)` and skip the analyzer entirely. Necessary for the "ship a recorded scope with the app binary" pattern and for sync-coordinator scenarios where one process analyzes and another watches.
- **Layering.** The assertion/MV consumers inside the engine bypass the public API and feed `DeltaSubscription`s directly from `extractBindings`, but the *shape* they use is parallel to the public one. If the public scope shape proves out, internal consumers can migrate to it too (separate ticket).

### Composition helpers

Ship in `change-scope.ts`:

```typescript
export function unionScopes(a: ChangeScope, b: ChangeScope): ChangeScope;
export function intersectScopes(a: ChangeScope, b: ChangeScope): ChangeScope;
export function bindParameters(scope: ChangeScope, params: SqlParameters | SqlValue[]): ChangeScope;
export function isEmpty(scope: ChangeScope): boolean;       // no watches AND no nondet sources
export function describesEverything(scope: ChangeScope): boolean; // ≥1 watch is `full` over every column
```

Behaviour: `union` per-table widens (`rows ∪ groups` → `full`, etc.); `intersect` per-table narrows; `bindParameters` substitutes ScopeValue placeholders and clears matching `unboundParameters` entries. `union` and `intersect` must agree with `deepEqual` modulo ordering — sort watches deterministically (by qualified table name) before returning.

These are tiny but tedious to write correctly. The lattice rules are:

- `full` ∨ anything = `full`
- `groups(G1)` ∨ `groups(G2)` = `groups(G1 ∪ G2)` if `G1 ⊆ G2` or vice versa; otherwise `full` (no general LCM)
- `rows(K, V1)` ∨ `rows(K, V2)` = `rows(K, V1 ∪ V2)` if `K` matches; otherwise `full`
- `rowsByGroup` follows the same pattern as `rows` with the additional `groupBy` index

`intersect` is the dual; document the precise rules in `docs/change-scope.md`.

### Use cases this enables

- **Reactive UI / live queries.** App calls `getChangeScope`, persists it next to the query in its store, calls `watch` to attach a re-fetch callback. Reuses the engine's classification work.
- **Custom CDC routing.** App routes its own change feed (e.g. from `quereus-sync` or an external broker) through `intersectScopes` to decide which subscribers to notify, without depending on the in-process watcher at all.
- **Cross-process subscriptions.** Process A analyzes (`getChangeScope`) and ships the scope over the wire; Process B (which holds the database) calls `watch`. The data contract is the only thing they have to share.
- **Codegen / build-time scope baking.** A build step pre-analyzes all queries in the app, persists their scopes to a manifest, and the runtime never re-analyzes. Saves planning cost and lets the build step audit which tables/columns each query touches.
- **Scope-aware caching.** App keys its query cache by `(sql, params)` and invalidates entries when their scope intersects a transaction's effects. The cache layer can be built without any callbacks at all if the app drives invalidation imperatively.

### Out of scope

- A network protocol for sync-coordinator change-scope distribution. The data contract is JSON-serializable; the protocol is a separate ticket.
- Refining the subquery-as-row-source case into a non-`full` watch shape. Recorded in `docs/change-scope.md` § "Known imprecisions" as a known limitation with the static-only policy.
- Re-pointing internal consumers (assertions, MV) at the public `ChangeScope` shape. They keep using `DeltaSubscription` directly until that migration earns its own ticket.
- Mid-transaction firing (watch-during-tx). The kernel is COMMIT-time; introducing pre-commit hooks is a separate concern with savepoint-interaction questions of its own.
- Watch on system catalogs / DDL changes. First cut watches user tables only; catalog changes are out of band.

## Tests

Place SQL-level integration tests in `test/logic/change-scope.spec.ts` (driving prepared statements through `getChangeScope` and asserting the resulting structure) and unit tests for the analyzer + helpers in `test/optimizer/change-scope-analyzer.spec.ts`.

Analyzer (unit):
- `select * from t where pk = ?` → one `TableWatch` on `t`, `{kind: 'rows', key: ['pk'], values: [[ParamRef(0, int)]]}`, `unboundParameters: [0]`.
- Same, with `params: [7]` passed → `values: [[7]]`, `unboundParameters: []`.
- `select sum(total) from orders where customer_id = ?` → `orders` group-scoped on `[customer_id]` with `values: [[ParamRef(0)]]`.
- `select sum(total) from orders where customer_id in (select id from premium_customers)` → `orders` `{kind: 'full'}`, `premium_customers` `{kind: 'full'}` on `id`-only columns.
- `select now()` → empty `watches`, `nonDeterministicSources: [{kind:'time'}]`.
- `select count(*) from t` → `t` with `{kind: 'full'}` and `columns: 'all'` (count touches every row, no column projection narrows it).
- `select a from t` → `t` with `{kind: 'full'}` but `columns: {a}` (column projection narrows the column set even when row scope is full).
- Volatile UDF referenced → `nonDeterministicSources` contains a `volatileUdf` entry with the name.

Composition helpers (unit):
- `unionScopes` with disjoint tables produces concatenation.
- `unionScopes` of `rows(pk, [7])` and `rows(pk, [8])` on same table → `rows(pk, [7, 8])`.
- `unionScopes` of `rows(pk, …)` and `groups(g, …)` on same table → `full`.
- `intersectScopes` is the dual; round-trip property test on random scope pairs.
- `bindParameters` substitutes and clears the unbound index.
- JSON round-trip via `structuredClone` preserves `deepEqual` equality.

Watcher (integration):
- A handler registered for `rows(pk, [7])` fires on update of row 7 with `hits: [[7]]`, does not fire on update of row 8.
- A handler registered for `groups([customer_id])` fires once per distinct group key touched.
- A handler registered for `full` fires when any row of the table mutates, hits empty.
- `unsubscribe` stops further firings; idempotent.
- Hand-built scope (no statement involved) registers and fires correctly — proves the watcher is plan-independent.
- Multi-table scope fires once per matching transaction with all relevant `MatchedWatch` entries.

Property tests (extend the existing optimizer property suite):
- For random simple queries, the analyzed scope is a *superset* of the true minimum scope (no false negatives): mutate a column not mentioned in the scope, verify the query result is unchanged. Mutate a column in the scope, verify the result *might* change (not asserting it does — coarse but valid). This catches regressions where the analyzer drops a dependency.

## Documentation

Mandatory updates as part of this ticket — these are not optional and should be checked off at review:

- **`docs/architecture.md`** — add a brief entry under "Key Design Decisions" mentioning that the engine exposes per-statement change-scope introspection backed by the FD framework, with a link to `docs/change-scope.md`. Update the Pipeline Overview if the new analyzer module deserves a mention alongside `analysis/`.
- **`docs/optimizer.md`** — in the "Binding-aware Delta Planning" section, note that the public `ChangeScope` shape is the external projection of the internal `BindingMode`. Cross-link to the new doc.
- **`docs/usage.md`** — add an examples section "Reactive subscriptions and change-scope introspection" with three code snippets: analyzer-only, watcher-with-hand-built-scope, end-to-end with both halves.
- **`docs/change-scope.md`** *(new)* — own the topic in depth. Cover: the data contract (with the full interface listing), how the analyzer derives each field, the static-only policy on subquery-sourced bindings (with worked examples), the firing semantics of the watcher, the composition lattice rules, the JSON round-trip guarantee, and a "Known imprecisions" section enumerating conservative-fallback cases. Cross-link back to `docs/optimizer.md` for the underlying FD machinery.
- **`packages/quereus/README.md`** — single sentence in the feature list mentioning reactive change-scope subscriptions, linking to the new doc.

## Open design points worth flagging during implement

These each have a defensible default — listed so the implementer makes the call explicitly rather than implicitly:

- **Column tracking on `full` row-scope.** A `{kind: 'full', columns: {a, b}}` watch is meaningful (full table scan but only `a`/`b` are read). Default: emit it. Watchers narrow firings to changes touching those columns.
- **Identity of `Subscription.id`.** Default: stable hash of the scope + a random nonce, so debug logs can correlate subscriptions across processes when a scope is shared.
- **Equality of qualified names.** Default: case-sensitive in the data contract, but `unionScopes` / `intersectScopes` normalize to the engine's existing identifier resolution. Document this — it's a sharp edge.
- **What `getChangeScope` does for DML statements.** Default: legal, returns the change scope of any RETURNING clause; for a plain INSERT/UPDATE/DELETE with no result columns the scope is empty `watches` with `unboundParameters` from the WHERE clause if any. Document and test.
