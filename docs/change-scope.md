# Change-scope introspection

The **change-scope** API exposes — as a small JSON-serializable data
contract — what base-table state and external inputs a prepared
`Statement` reads from. It is the external projection of the internal
binding-key analysis used by assertions and incremental view
maintenance (see [optimizer.md](optimizer.md) § "Binding-aware Delta
Planning").

A `ChangeScope` answers questions like:

- "Which tables does this query depend on, and which columns of each?"
- "If I want to know when this query's result might change, what
  rows/groups/parameters must I watch?"
- "Does this query depend on time, random, or external (parameter)
  inputs that watching state alone cannot detect?"

The companion `Database.watch` watcher (ships in a follow-up ticket)
consumes the same shape end-to-end. The change-scope API itself stops
at *analysis*: it produces the description; the watcher fires
callbacks.

## Data contract

```ts
interface ChangeScope {
  readonly watches: ReadonlyArray<TableWatch>;
  readonly nonDeterministicSources: ReadonlyArray<NonDetSource>;
  readonly unboundParameters: ReadonlyArray<number | string>;
}

interface QualifiedName {
  readonly schema: string;   // lowercased
  readonly table: string;    // lowercased
}

interface TableWatch {
  readonly table: QualifiedName;
  readonly columns: ReadonlySet<string> | 'all';
  readonly scope: WatchScope;
}

type WatchScope =
  | { kind: 'full' }
  | { kind: 'rows';        key: readonly string[];      values: ReadonlyArray<ReadonlyArray<ScopeValue>> }
  | { kind: 'groups';      groupBy: readonly string[] }
  | { kind: 'rowsByGroup'; groupBy: readonly string[];  values: ReadonlyArray<ReadonlyArray<ScopeValue>> };

type ScopeValue = SqlValue | ParamScopeValue;

interface ParamScopeValue {
  readonly kind: 'param';
  readonly index: number | string;
  readonly type: PortableScalarType;
}

interface PortableScalarType {
  readonly typeName: string;     // logical type name (e.g. 'TEXT', 'INTEGER')
  readonly nullable: boolean;
  readonly collationName?: string;
  readonly isReadOnly?: boolean;
}

type NonDetSource =
  | { kind: 'time' }
  | { kind: 'random' }
  | { kind: 'volatileUdf'; name: string }
  | { kind: 'parameter'; index: number | string };
```

### `columns` semantics

For each `TableWatch.columns`:

- A `ReadonlySet<string>` lists the lowercased column names actually
  read by the plan (output projection plus filter/group/order/aggregate
  inputs).
- The sentinel `'all'` is used when the plan does not read any
  column-specific data (e.g. `select count(*) from t`).

A `kind: 'full'` watch with `columns: {a, b}` is meaningful: the
underlying query scans the table but only reads `a` and `b`. A future
watcher narrows row-change firings to changes that touch a watched
column.

### Equality, ordering, normalization

A `ChangeScope` returned by `analyzeChangeScope` is canonical:

- `watches` are sorted by `(schema, table)` then `scope.kind` then a
  deterministic key serialization of the scope.
- `unboundParameters` and `nonDeterministicSources` are
  sorted/deduplicated.
- Within a `rows`/`rowsByGroup` watch, `values` tuples are
  lex-sorted by their `ScopeValue` representation and duplicates are
  dropped.
- All qualified-table names use lowercased `schema` and `table` fields.

Two scopes describing the same constraints are deep-equal.

### Cloning and serialization

`ChangeScope` is plain data. Two equivalent round-trip paths are
supported:

```ts
// JSON path (wire-safe).
const wire = JSON.stringify(serializeChangeScope(scope));
const back = deserializeChangeScope(JSON.parse(wire));

// In-memory clone (no JSON, no string conversion).
const cloned = structuredClone(scope);
```

Both produce a value structurally identical to the input. The on-wire
shape uses sorted `string[]` for `TableWatch.columns` rather than a
`Set`; `deserializeChangeScope` re-hydrates it back into a
`ReadonlySet<string>`. `PortableScalarType` is intentionally a flat
data shape so the entire `ChangeScope` is `structuredClone`-safe; if
you need a full `ScalarType` (with the registered `LogicalType`'s
behaviour functions) from a portable shape, call
`scalarTypeFromPortable`.

### Composition lattice

`unionScopes(a, b)` widens; `intersectScopes(a, b)` narrows:

- Per table:
  - `full` ∨ anything = `full`.
  - `groups(G₁) ∨ groups(G₂)` keeps the shorter `groupBy` when one is a
    subset of the other; otherwise collapses to `full`.
  - `rows(K, V₁) ∨ rows(K, V₂)` merges the value sets when the keys
    match; otherwise collapses to `full`.
  - `rowsByGroup` follows `rows` with the additional `groupBy`
    constraint.
  - Mixed shapes (rows vs groups, etc.) collapse to `full` under union.
- `intersect` is the dual: same-key value sets are intersected; mismatched
  keys produce no watch for that table; nondeterministic-source and
  unbound-parameter sets are intersected.

`bindParameters(scope, params)` substitutes matching `ParamScopeValue`
placeholders with literal values and removes the bound indices from
`unboundParameters` and from `nonDeterministicSources` (kind `'parameter'`).

`isEmpty(scope)` is true iff `watches`, `nonDeterministicSources` and
`unboundParameters` are all empty.

`describesEverything(scope)` is true iff every watch is `full` and
covers every column (`columns === 'all'`) for every base table the
scope mentions.

## How the analyzer derives each field

`analyzeChangeScope(plan, options?)` accepts a `PlanNode` and:

1. Calls `extractBindings(plan)` from `binding-extractor.ts` to obtain
   a `BindingMode` per `TableReferenceNode` instance (see
   [optimizer.md](optimizer.md)).
2. Walks the scalar-expression tree to collect, per
   `TableReferenceNode`, the set of column indices its
   `ColumnReferenceNode`s touch.
3. Walks the scalar-expression tree to collect
   `nonDeterministicSources`:
   - Function calls whose schema does **not** carry
     `FunctionFlags.DETERMINISTIC`. Well-known builtins are mapped to
     `{kind: 'time'}` (`now`, `current_timestamp`, `date`, `time`,
     `datetime`, `julianday`, `epoch_s`, `epoch_ms`, `epoch_s_frac`,
     `strftime`) or `{kind: 'random'}` (`random`, `randomblob`); the
     rest become `{kind: 'volatileUdf', name}`.
   - Parameters referenced *outside* a recognized row/group binding
     equality become `{kind: 'parameter', index}` — the only signal
     that "watching state alone cannot tell you when the result
     changes."
4. For each `TableReferenceNode`, translates its `BindingMode`:
   - `global` → `{kind: 'full'}`.
   - `row {keyColumns}` → `{kind: 'rows', key, values}` with values
     drawn from the equality predicates that supplied the binding
     (literals stay as literals, parameters become `ParamScopeValue`
     placeholders).
   - `group {groupColumns}` → `{kind: 'rowsByGroup', groupBy, values}`
     when the predicates above the aggregate also pinned the binding
     values; otherwise `{kind: 'groups', groupBy}`.
5. Normalizes the result (sorting + dedup) before returning it.

If `options.params` is supplied (`SqlValue[]` or
`Record<string, SqlValue>`), the result has
`bindParameters(scope, params)` applied to it before being returned.

### DML statements

For an UPDATE / INSERT / DELETE plan:

- **With `RETURNING`**: the analyzer treats the RETURNING projection as
  a SELECT over the affected rows. Watches reflect the rows being
  returned (typically a `rows` scope on the target table's PK).
- **Without `RETURNING`**: the statement does not surface table state
  to the caller. `watches` is empty. Parameters in the WHERE / SET
  clauses still appear in `unboundParameters` so a caller binding the
  statement repeatedly can still observe what it parameterizes on.

## The two cases that look the same but are not

Row-binding values come from two structurally similar SQL constructs;
the analyzer treats them differently and you should too:

| Source of binding values        | Treatment                                                                                                                                                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unbound parameter (`where pk = ?`) | `{kind:'rows', key, values:[[ParamRef]]}`. Adds the index to `unboundParameters`. `analyzeChangeScope(plan, {params})` resolves the placeholder to a literal and removes the index from `unboundParameters`.                          |
| Subquery (`where pk in (select id from t2)`) | Falls back to `{kind:'full'}` for that watch. The subquery's source table gets its own `TableWatch`. Refining "watch rows of A whose key joins to current rows of B" is *out of scope* for v1 — see Known imprecisions.        |

## Known imprecisions

`analyzeChangeScope` is a sound, **conservative** static analysis: it
never describes *less* than what the query may read, but it sometimes
describes more.

- **Subquery-sourced row bindings.** Equality of a key against a
  subquery (`where pk in (select id from premium)`) collapses to
  `{kind:'full'}` for both tables. A refined "rows-of-A whose key
  joins to current rows-of-B" mode is deferred.
- **Unrecognized non-deterministic functions.** A function declared
  with `deterministic: false` whose name is neither in the known time
  set nor the known random set becomes
  `{kind: 'volatileUdf', name: <lowercased>}`. Callers that want to
  treat a custom UDF as time-like or random-like can post-process the
  scope themselves.
- **DML without `RETURNING`** produces empty watches by design — the
  statement returns no data, so the caller has nothing to "watch."
  Parameters used in the WHERE/SET clauses are preserved in
  `unboundParameters`.
- **Joins where binding extraction couldn't pin a key.** The analyzer
  falls back to `{kind:'full'}` rather than guessing. This is not a
  bug but may surprise callers who expect inter-table propagation
  beyond what the equivalence-class machinery already provides.
- **Row bindings whose values are non-literal/non-parameter expressions.**
  If the binding extractor sees an equality on a unique key but the
  right-hand side is a complex expression (e.g. `pk = coalesce(?, 0)`)
  that the analyzer cannot decode into a `ScopeValue`, the watch falls
  back to `{kind:'full'}` rather than emitting `{kind:'rows', values: []}`
  (which would describe "watch zero rows" and under-specify the scope).

## See also

- [optimizer.md](optimizer.md) — § "Binding-aware Delta Planning" describes
  the internal `BindingMode` shape this API projects.
- [incremental-maintenance.md](incremental-maintenance.md) — runtime
  surface for delta-driven consumers (assertions today, MVs and
  watchers tomorrow).
