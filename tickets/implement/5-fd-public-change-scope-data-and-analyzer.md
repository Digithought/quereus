---
description: Public ChangeScope data contract, Statement.getChangeScope analyzer, and composition helpers (analyzer half of the public change-scope API)
prereq: fd-view-maintenance-binding-keys
files:
  - packages/quereus/src/core/statement.ts
  - packages/quereus/src/planner/analysis/change-scope.ts
  - packages/quereus/src/planner/analysis/binding-extractor.ts
  - packages/quereus/src/index.ts
  - packages/quereus/test/optimizer/change-scope-analyzer.spec.ts
  - packages/quereus/test/logic/change-scope.spec.ts
  - docs/change-scope.md
  - docs/optimizer.md
  - docs/usage.md
  - packages/quereus/README.md
---

This is the **first half** of the public change-scope API. It introduces the
serializable `ChangeScope` data contract, the analyzer that derives it from
a prepared `Statement`, and a small set of composition helpers. The
**second half** (`Database.watch` watcher) ships in
`fd-public-change-scope-watcher` and depends on this ticket landing first.

The internal `extractBindings` / `BindingMode` / `DeltaSubscription` shapes
already exist (under `packages/quereus/src/planner/analysis/binding-extractor.ts`
and `packages/quereus/src/runtime/delta-executor.ts`) and stay unchanged —
this ticket adds the *public projection* of that machinery, not a rewrite.

## Architecture

### Data contract

New module `packages/quereus/src/planner/analysis/change-scope.ts` exports
the following types. All shapes are JSON-serializable (use plain arrays for
the column sets in the wire form; `ReadonlySet<string>` is the in-memory
shape for ergonomics — see "Serialization" below).

```typescript
import type { SqlValue } from '../../common/types.js';
import type { ScalarType } from '../../common/datatype.js';

export interface QualifiedName {
  readonly schema: string;   // lowercased
  readonly table: string;    // lowercased
}

export interface ChangeScope {
  readonly watches: ReadonlyArray<TableWatch>;
  readonly nonDeterministicSources: ReadonlyArray<NonDetSource>;
  readonly unboundParameters: ReadonlyArray<number>;
}

export interface TableWatch {
  readonly table: QualifiedName;
  readonly columns: ReadonlySet<string> | 'all';
  readonly scope: WatchScope;
}

export type WatchScope =
  | { readonly kind: 'full' }
  | { readonly kind: 'rows';        readonly key: readonly string[];      readonly values: ReadonlyArray<ReadonlyArray<ScopeValue>> }
  | { readonly kind: 'groups';      readonly groupBy: readonly string[] }
  | { readonly kind: 'rowsByGroup'; readonly groupBy: readonly string[];  readonly values: ReadonlyArray<ReadonlyArray<ScopeValue>> };

export type ScopeValue =
  | SqlValue
  | { readonly kind: 'param'; readonly index: number; readonly type: ScalarType };

export type NonDetSource =
  | { readonly kind: 'time' }
  | { readonly kind: 'random' }
  | { readonly kind: 'volatileUdf'; readonly name: string }
  | { readonly kind: 'parameter'; readonly index: number };
```

#### Serialization

- `ChangeScope` round-trips through `JSON.stringify` / `JSON.parse` after
  one normalization step: `TableWatch.columns` is a `ReadonlySet<string>`
  in memory but a sorted `string[]` (or the literal `'all'`) on the wire.
- Ship `serializeChangeScope(scope) → object` and
  `deserializeChangeScope(obj) → ChangeScope` helpers in
  `change-scope.ts` so callers do not have to know this.
- `ScopeValue.param` placeholders survive round-trip as object literals.
- `structuredClone(scope)` works without going through JSON because
  everything is plain data (Sets are clonable). Test both paths.

#### Equality and ordering

- Two scopes describing the same constraints must be `deepEqual`.
- Watches in the returned scope are **sorted** by `(schema, table)` then
  `kind` then a deterministic key serialization, so callers can compare
  scopes structurally without manual normalization.
- `unboundParameters` and `nonDeterministicSources` are sorted/deduped.
- Within a `rows` / `rowsByGroup` watch, `values` rows are sorted
  lex-asc by their `ScopeValue` representation; duplicates are dropped.

### Analyzer

New top-level export from `change-scope.ts`:

```typescript
export function analyzeChangeScope(
  plan: PlanNode,
  options?: { params?: SqlParameters | SqlValue[] }
): ChangeScope;
```

The analyzer takes a `PlanNode` (not a `Statement`) so it is testable in
isolation. It composes:

1. `extractBindings(plan)` from `binding-extractor.ts` — gives one
   `BindingMode` per `TableReferenceNode` instance.
2. A column-projection walk over the plan that, for each base table,
   collects the set of columns actually referenced (output projection +
   filter/group/order/aggregate inputs). Empty set with non-empty plan
   reads → `'all'` (count(*) and friends).
3. A scalar-expression walk over the plan that collects:
   - Function calls whose `FunctionSchema.flags & FunctionFlags.DETERMINISTIC`
     is zero. Map well-known names (`now`, `current_timestamp`, `epoch_ms`,
     `random`, `randomblob`) to `{kind: 'time'}` / `{kind: 'random'}`;
     anything else becomes `{kind: 'volatileUdf', name}`.
   - `ParameterReferenceNode`s that appear *outside* a recognized
     row-binding equality. These become `{kind: 'parameter', index}` in
     `nonDeterministicSources` so callers know "the result depends on this
     parameter, watching state alone won't catch it."
4. For each `TableReferenceNode`, translate the `BindingMode`:
   - `{kind: 'global'}` → `WatchScope = {kind: 'full'}` (or
     `{kind: 'groups', groupBy}` if a group key survives in
     `groupKeys.get(relKey)` even when classification is global —
     check both shapes and prefer the narrower).
   - `{kind: 'row', keyColumns}` →
     `{kind: 'rows', key: [...colNames], values: [...]}`. The values
     come from inspecting the equality predicates already extracted by
     `constraint-extractor` (see `extractCoveredKeysForTable`); each
     value is either a `SqlValue` literal or a `ScopeValue.param`
     placeholder.
   - `{kind: 'group', groupColumns}` → if there is a row binding
     under the group, fold to `{kind: 'rowsByGroup', groupBy, values}`;
     otherwise `{kind: 'groups', groupBy}`.

#### The two cases that look the same but are not

This distinction is **the policy** for v1 and must be tested explicitly:

| Source of binding values | Treatment |
| --- | --- |
| Unbound parameter (`where pk = ?`) | Emit `{kind:'rows', key, values:[[ParamRef]]}`. Add the param index to `unboundParameters`. Calling `analyzeChangeScope(plan, {params})` resolves the placeholder to a literal and removes the index from `unboundParameters`. |
| Subquery (`where pk in (select id from t2)`) | Fall back to `{kind:'full'}` for that watch. The subquery's source table gets its own `TableWatch`. Document this as a known imprecision. |

Refining the subquery case (e.g., a "watch rows of A whose key joins to
current rows of B" mode) is **out of scope**. Add a paragraph to
`docs/change-scope.md` § "Known imprecisions" calling it out.

### Statement wrapper

In `packages/quereus/src/core/statement.ts`, add:

```typescript
public getChangeScope(params?: SqlParameters | SqlValue[]): ChangeScope {
  const plan = this.getOptimizedPlan(); // existing internal method/path
  return analyzeChangeScope(plan, { params });
}
```

If the wrapper needs a public-API surface for the optimized plan, add a
private accessor — do not expose the BlockNode itself. Statements that
have not yet been compiled should compile on demand (same path as
`step()` / `getColumnDefs`).

For DML statements (INSERT/UPDATE/DELETE):
- With a RETURNING clause → returns the change scope of the RETURNING
  query (analyzer treats it as a SELECT over the affected rows).
- Without RETURNING → empty `watches`, but `unboundParameters` still
  reflects parameters in the WHERE clause. Document and test.

### Composition helpers

Ship in `change-scope.ts`:

```typescript
export function unionScopes(a: ChangeScope, b: ChangeScope): ChangeScope;
export function intersectScopes(a: ChangeScope, b: ChangeScope): ChangeScope;
export function bindParameters(scope: ChangeScope, params: SqlParameters | SqlValue[]): ChangeScope;
export function isEmpty(scope: ChangeScope): boolean;            // no watches AND no nondet sources
export function describesEverything(scope: ChangeScope): boolean; // ≥1 watch is `full` over every column
```

Lattice rules (per-table):

- `full` ∨ anything = `full`.
- `groups(G1)` ∨ `groups(G2)` = `groups(G1 ∪ G2)` if `G1 ⊆ G2` or vice versa; otherwise `full`.
- `rows(K, V1)` ∨ `rows(K, V2)` = `rows(K, V1 ∪ V2)` if `K` matches; otherwise `full`.
- `rowsByGroup` follows `rows` with the additional `groupBy` index.

`intersect` is the dual (narrowest scope wins; same-key value sets are
intersected; mismatched keys → empty for that table → drop the watch).

`bindParameters` substitutes matching `ScopeValue.param` placeholders with
literals and removes the corresponding indices from `unboundParameters`.

### Public re-exports (audit checklist)

`packages/quereus/src/index.ts` must add a single block re-exporting:

```typescript
export type {
  ChangeScope, TableWatch, WatchScope, ScopeValue, NonDetSource, QualifiedName,
} from './planner/analysis/change-scope.js';
export {
  analyzeChangeScope, unionScopes, intersectScopes, bindParameters,
  isEmpty, describesEverything,
  serializeChangeScope, deserializeChangeScope,
} from './planner/analysis/change-scope.js';
```

(`Subscription`, `WatchEvent`, `MatchedWatch`, `WatchHandler` ship in the
watcher ticket, not here.)

### Documentation (must land in this ticket)

- **`docs/change-scope.md`** *(new)* — full topic doc. Sections:
  data contract (with the interface listing), how the analyzer derives
  each field, the static-only policy on subquery-sourced bindings (with
  worked examples), composition lattice rules, the JSON / structuredClone
  round-trip guarantee, "Known imprecisions" enumerating conservative
  fallbacks (subquery row sources, unrecognized non-deterministic
  functions, DML without RETURNING). End with a "See also" pointer to
  `docs/optimizer.md` § "Binding-aware Delta Planning". Note that the
  `Database.watch` watcher half is described in the ticket-pair sibling
  doc once it lands.
- **`docs/optimizer.md`** — in the "Binding-aware Delta Planning" section,
  one paragraph noting that the public `ChangeScope` shape is the external
  projection of the internal `BindingMode`, with a cross-link to the new
  doc.
- **`docs/architecture.md`** — add a brief entry under "Key Design Decisions"
  mentioning per-statement change-scope introspection backed by the FD
  framework, with a link to `docs/change-scope.md`. Mention the new
  analyzer module in the Pipeline Overview if appropriate.
- **`docs/usage.md`** — add an examples section "Change-scope introspection"
  with two snippets: analyzer-only (`statement.getChangeScope()`),
  analyzer + composition (`unionScopes(a, b)`, `bindParameters(scope, [7])`).
  A third end-to-end snippet using `database.watch` lands in the watcher
  ticket.
- **`packages/quereus/README.md`** — single sentence in the feature list
  mentioning change-scope introspection (watcher mention deferred).

## Open design points (defaults are committed, not optional)

- **Column tracking on `full` row-scope.** A `{kind: 'full', columns: {a,b}}`
  watch is meaningful (full table scan but only `a`/`b` are read).
  Default: emit it. Watchers will narrow firings to changes touching those
  columns.
- **Equality of qualified names.** Default: lowercase canonicalization at
  the data-contract boundary. `unionScopes` / `intersectScopes` may assume
  inputs are already canonical and normalize defensively. Document this in
  `docs/change-scope.md`.
- **What `getChangeScope` does for DML statements.** Default as described
  above (RETURNING-aware, empty otherwise). Document and test both shapes.
- **`nonDeterministicSources.parameter` for unbound params used outside
  row-binding equalities.** Emit it. This is the only signal a watcher-side
  caller has that "watching state alone cannot catch result changes."
- **Empty `watches` with non-empty `nonDeterministicSources`.** Legal —
  represents a query like `select now()`. `isEmpty` returns `false` for it.

## Tests

### Analyzer (`test/optimizer/change-scope-analyzer.spec.ts`, unit)

Unit tests run the analyzer against hand-built or `db.prepare`-built plans
and inspect the returned `ChangeScope`.

- `select * from t where pk = ?` →
  one `TableWatch` on `t`, `{kind:'rows', key:['pk'], values:[[ParamRef(0,int)]]}`,
  `unboundParameters: [0]`.
- Same with `params: [7]` → `values:[[7]]`, `unboundParameters: []`.
- `select sum(total) from orders where customer_id = ?` →
  `orders` `{kind:'rowsByGroup', groupBy:['customer_id'], values:[[ParamRef(0)]]}`
  (or `groups` if no row binding survives — the test should accept either
  but document the chosen output with a comment).
- `select sum(total) from orders where customer_id in (select id from premium_customers)` →
  `orders` `{kind:'full'}` (with column set narrowed to `{customer_id, total}`),
  `premium_customers` `{kind:'full'}` with column set `{id}`.
- `select now()` → empty `watches`, `nonDeterministicSources: [{kind:'time'}]`.
- `select count(*) from t` → `t` `{kind:'full'}`, `columns: 'all'`.
- `select a from t` → `t` `{kind:'full'}`, `columns: {'a'}`.
- Volatile UDF referenced → `nonDeterministicSources` contains
  `{kind:'volatileUdf', name:'<udfName>'}`.
- DML `update t set x = ? where pk = ?` (no RETURNING) → empty `watches`,
  `unboundParameters: [0, 1]`.
- DML `update t set x = ? where pk = ? returning x` → one `TableWatch`
  on `t` rows-scoped on `pk = ParamRef(1)`.

### Composition helpers (`test/optimizer/change-scope-analyzer.spec.ts`, unit)

- `unionScopes` with disjoint tables → concatenation, sorted.
- `unionScopes` of `rows(pk,[7])` and `rows(pk,[8])` on same table →
  `rows(pk,[7,8])`.
- `unionScopes` of `rows(pk,…)` and `groups(g,…)` on same table → `full`.
- `intersectScopes` is the dual; round-trip property test on small
  random scope pairs.
- `bindParameters` substitutes and clears the index; matching params not
  present in the scope are no-ops.
- `JSON.parse(JSON.stringify(serializeChangeScope(scope)))` followed by
  `deserializeChangeScope` round-trips to a `deepEqual` value.
- `structuredClone(scope)` round-trips to `deepEqual`.
- `isEmpty` true for `{watches:[], nonDeterministicSources:[], unboundParameters:[]}`,
  false for `select now()` scope.
- `describesEverything` true when one `full` watch covers `'all'` columns
  on every base table the input scope mentions.

### Logic / integration (`test/logic/change-scope.spec.ts`)

Integration tests prepare statements through `db.prepare(...)`, call
`getChangeScope`, and assert the resulting structure. Cover at least:

- Equality of two prepared statements over equivalent SQL produces
  `deepEqual` scopes (modulo parameter substitution).
- A scope serialized and deserialized matches the live one.
- A statement with explicit parameter types yields `ScopeValue.param`
  placeholders carrying the right `ScalarType`.

### Property test (extend existing optimizer property suite if cheap; otherwise skip with note)

For random simple queries, the analyzed scope is a *superset* of the
true minimum scope: mutate a column not mentioned in the scope, verify
the query result is unchanged (no false negatives). This is optional —
defer to the watcher ticket if not trivial here, since it benefits more
from end-to-end validation.

## TODO

- Add `change-scope.ts` module with the data contract, `analyzeChangeScope`,
  composition helpers, and serialization helpers.
- Implement the column-projection walk and the non-deterministic-function
  walk on top of the existing scalar-plan-node tree.
- Reuse `extractBindings` and `extractCoveredKeysForTable` for binding
  shape and key values.
- Wire `Statement.getChangeScope` to the analyzer.
- Add the public re-exports to `packages/quereus/src/index.ts`.
- Land all four doc updates listed above (new `docs/change-scope.md`,
  edits to `docs/optimizer.md`, `docs/architecture.md`, `docs/usage.md`,
  and one-line addition to `packages/quereus/README.md`).
- Add `test/optimizer/change-scope-analyzer.spec.ts` (unit) and
  `test/logic/change-scope.spec.ts` (integration).
- Run `yarn lint`, `yarn build`, `yarn test`.

## Implement-stage handoff (fill in for the reviewer)

When closing this ticket, the implement summary must include:

- Exact list of new exports added to `packages/quereus/src/index.ts`.
- Confirmation each documentation file in the list above was updated.
- Whether the optional property test was implemented or deferred (and
  why if deferred).
- Any analyzer cases that fall back to `{kind:'full'}` more conservatively
  than the design implies (e.g., a join shape where binding extraction
  could not pin a key) — these are not bugs but the reviewer should know.
