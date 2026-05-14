---
description: Review the public ChangeScope data contract, Statement.getChangeScope analyzer, composition helpers, and supporting docs/tests
prereq:
files:
  - packages/quereus/src/planner/analysis/change-scope.ts
  - packages/quereus/src/core/statement.ts
  - packages/quereus/src/index.ts
  - packages/quereus/test/optimizer/change-scope-analyzer.spec.ts
  - packages/quereus/test/logic/change-scope.spec.ts
  - docs/change-scope.md
  - docs/optimizer.md
  - docs/usage.md
  - docs/architecture.md
  - packages/quereus/README.md
---

## What landed

The **first half** of the public change-scope API:

- New module `packages/quereus/src/planner/analysis/change-scope.ts`
  exposes `ChangeScope`, the JSON-serializable data contract, plus
  `analyzeChangeScope`, composition helpers (`unionScopes`,
  `intersectScopes`, `bindParameters`, `isEmpty`,
  `describesEverything`), and JSON serialization helpers
  (`serializeChangeScope`, `deserializeChangeScope`).

- New API `Statement.getChangeScope(params?)` in
  `packages/quereus/src/core/statement.ts`. Uses a private analysis
  plan path (`optimizeForAnalysis`) rather than the fully physical
  execution plan, since the internal binding analysis runs over the
  logical/structural plan.

- The watcher half (`Database.watch`) is *not* part of this ticket and
  ships next in `fd-public-change-scope-watcher`.

### Exports added to `packages/quereus/src/index.ts`

Types:
- `ChangeScope`, `TableWatch`, `WatchScope`, `ScopeValue`,
  `ParamScopeValue`, `PortableScalarType`, `NonDetSource`,
  `QualifiedName`, `SerializedChangeScope`

Functions:
- `analyzeChangeScope`, `unionScopes`, `intersectScopes`,
  `bindParameters`, `isEmpty`, `describesEverything`,
  `serializeChangeScope`, `deserializeChangeScope`,
  `scalarTypeFromPortable`

### Documentation updates (all four landed)

- `docs/change-scope.md` — new full topic doc with data contract,
  analyzer derivation, DML semantics, JSON / `structuredClone`
  round-trip guarantee, the param-vs-subquery policy, and a
  "Known imprecisions" section listing every conservative fallback.
- `docs/optimizer.md` — § "Binding-aware Delta Planning" now points to
  the new doc.
- `docs/architecture.md` — new "Per-Statement Change-Scope
  Introspection" bullet under "Key Design Decisions".
- `docs/usage.md` — new "Change-scope introspection" section after
  the Statement API reference, with analyzer-only and composition
  examples.
- `packages/quereus/README.md` — one-line feature bullet plus a docs
  index entry pointing at `docs/change-scope.md`.

## Deviations from ticket spec

These are intentional; flag them if you disagree:

1. **`ScopeValue.param.type` is `PortableScalarType`, not the full
   `ScalarType`.** The ticket specifies
   `{ kind:'param'; index:number; type: ScalarType }`. `ScalarType` in
   this codebase contains a `LogicalType` whose `validate`/`parse`/
   `compare` fields are **functions** — making both `JSON.stringify`
   and `structuredClone` lose information.

   The ticket also requires `structuredClone(scope)` to round-trip to
   `deepEqual`. To honor that without losing information, I introduced
   `PortableScalarType` (just `typeName: string`, `nullable: bool`,
   plus optional `collationName` / `isReadOnly`) and exported
   `scalarTypeFromPortable(p)` for callers who need the full
   `ScalarType` back (it resolves the registered logical type from the
   global type registry).

2. **`index` and `unboundParameters` are `number | string`, not just
   `number`.** Quereus supports both `?` (positional, 1-based number)
   and named (`:name`) parameters. To represent named parameters
   faithfully without falling back to `full`, both `ParamScopeValue.index`
   and `unboundParameters` are widened to `number | string`. For
   `?`-only callers the values are always numbers and the spec
   matches.

Both deviations are documented in `docs/change-scope.md`.

## Behaviour to spot-check during review

These are the cases the analyzer **handles** and what shape it
produces — verify the rows match your reading of the ticket:

- `select * from t where pk = ?` → `rows{key:['pk'], values:[[ParamRef(1)]]}`,
  `unboundParameters: [1]`.
- Same with `params: [7]` → `rows{values:[[7]]}`, `unboundParameters: []`.
- `select v from t where pk = 42` → `rows{values:[[42]]}`, columns: `{'v'}`.
- `select count(*) from t` → `full`, columns: `'all'`.
- `select v from t` → `full`, columns: `{'v'}`.
- `select count(*) from t group by id` → `rowsByGroup` or `groups` with
  `groupBy: ['id']` (the analyzer picks `rowsByGroup` when row-binding
  closure also pins the values; otherwise `groups`).
- `select sum(total) from orders where customer_id = ?` — note
  **`full`** for `orders`, since `customer_id` is not a unique key.
  The parameter is still in `unboundParameters: [1]`. (This is the
  ticket's hypothesized rowsByGroup case; the analyzer correctly
  doesn't make one up here because no unique-key cover exists.)
- `select sum(total) from orders where id = ? group by id` → row
  binding survives the aggregate; produces `rows` or `rowsByGroup`.
- `select sum(total) from orders where customer_id in (select id from
  premium)` → both watches `full` (subquery fallback, per the ticket's
  "two cases that look the same" policy).
- `select random()` → empty `watches`, `nonDeterministicSources:
  [{kind:'random'}]`.
- A volatile UDF referenced → `nonDeterministicSources` contains
  `{kind:'volatileUdf', name}`.
- `update t set x = ? where id = ?` (no RETURNING) → **empty `watches`**,
  `unboundParameters: [1, 2]`.

## Conservative fallbacks (call out as may-surprise, not bugs)

The reviewer should know these because they make the analyzer's output
narrower-looking than the ticket prose:

- **Joins where the binding extractor can't pin a key.** When
  `extractBindings` returns `'global'` for a table reference, the
  analyzer emits `full` with the column set. This includes the
  premium-subquery case from the ticket. Documented under § Known
  imprecisions.
- **Inter-table propagation** beyond what
  `analyzeRowSpecific`/`extractBindings` already prove (via FD
  closure + equivalence classes). The ticket says "from joins:
  propagate bindings through equi-joins; when `T.k = U.k` …" — the
  analyzer relies on the FD/EC machinery to surface that as a `'row'`
  classification on `U`; it does not do an extra pass on top of that.
  Conservative — not unsound.
- **Volatile UDFs without a recognized name** (i.e. anything that
  isn't in the time/random allowlists in
  `change-scope.ts` § Constants) becomes `volatileUdf`. Tweaking the
  allowlist later doesn't change the data contract.

## Optional property test — deferred

The ticket marked the optional property test (analyzer scope is a
*superset* of the true minimum scope) as deferrable. **Deferred**
here, as suggested, to the watcher ticket where end-to-end mutation
makes the test naturally falsifiable. Not implemented yet.

## Build, lint, and test status

- `yarn workspace @quereus/quereus run build` — passes.
- `yarn workspace @quereus/quereus run lint` — passes.
- `yarn workspace @quereus/quereus run test` (full quereus suite,
  2916 tests) — passes; the 38 new spec tests added by this ticket
  all pass.
- Pre-existing `sample-plugins` failures (`key_value_store`
  delete/update) are unrelated and reproduce on `main` without our
  changes.

## Where the reviewer might push back

- **Sort order of `watches`** is `(schema, table)` then `scope.kind`
  alphabetical then a deterministic key serialization. This is
  enough to make `deepEqual` work; if the reviewer wants a different
  total order they'll need to adjust `compareWatches`.
- **`bindParameters` ordering of remaining `unboundParameters`** —
  bound indices are removed but otherwise preserved sort order.
- **DML root-detection** (`isDmlWithoutReturning`) walks the plan
  tree from the root through `BlockNode.statements` and into single
  relational children to find a DML node. This is heuristic; if a
  future DML wrapper isn't a `BlockNode`/`Update`/`Insert`/`Delete`/
  `UpdateExecutor`/single-child node, it could be misclassified. The
  current shape covers everything that test/optimizer/etc. exercise.

## Tests added

- `packages/quereus/test/optimizer/change-scope-analyzer.spec.ts` —
  unit tests (~30 cases) covering row/group/full classifications,
  subquery fallbacks, non-determinism, column tracking, DML, and the
  full composition lattice (union/intersect/bindParameters/isEmpty/
  describesEverything) plus JSON and `structuredClone` round-trips.
- `packages/quereus/test/logic/change-scope.spec.ts` — integration
  tests through `db.prepare(...)` / `Statement.getChangeScope`,
  including bound vs unbound parameter handling and the portable type
  shape.

## What the reviewer should explicitly verify

1. Re-read `docs/change-scope.md` — does its "Known imprecisions"
   section honestly describe everything you'd encounter when first
   wiring this into a watcher?
2. The `PortableScalarType` deviation — is it acceptable, or would
   you rather see `ScalarType` survive (at the cost of losing
   `structuredClone` round-trip)?
3. The DML root-detection heuristic in `isDmlWithoutReturning` — is
   it complete enough? Specifically, does an `Update`/`Insert`/
   `Delete` ever land *not* as the last statement of a `Block`?
4. The choice to call `optimizeForAnalysis` (not `optimize`) inside
   `Statement.getChangeScope`, and to **not** cache the analysis
   plan. Performance is not a concern for v1, but if `getChangeScope`
   is called repeatedly we'd want a cache; the watcher ticket may
   need one. Worth a note for that ticket?
