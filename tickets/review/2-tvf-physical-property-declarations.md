---
description: Review TVF physical/relational property advertisement surface — `relationalAdvertisement` on `TableValuedFunctionSchema`, wiring in `TableFunctionCallNode`, built-in annotations, validation, tests, and docs.
files:
  - packages/quereus/src/schema/function.ts
  - packages/quereus/src/func/registration.ts
  - packages/quereus/src/planner/nodes/table-function-call.ts
  - packages/quereus/src/func/builtins/generation.ts
  - packages/quereus/src/func/builtins/json-tvf.ts
  - packages/quereus/src/func/builtins/explain.ts
  - packages/quereus/src/func/builtins/schema.ts
  - packages/quereus/test/planner/tvf-physical-properties.spec.ts
  - docs/optimizer.md
  - docs/architecture.md
---

## What was built

TVF authors can now advertise relational and physical properties through an optional `relationalAdvertisement` field on `TableValuedFunctionSchema`. `TableFunctionCallNode` consumes the declaration on the standard `computePhysical` / `getType` paths, so downstream optimizer rules (FD propagation, DISTINCT elimination, monotonic-window rules, cardinality-aware planning) see the same information they get from a real vtab.

### Surface (schema/function.ts)

New exports:

- `TVFAdvertiseFn<T>` — callback `(operands, schema) => T | undefined` for parameter-dependent advertisements.
- `MonotonicOnColumnInfo` — `{ column, direction, strict? }`. Preferred over raw `MonotonicOnInfo` because the schema author talks in column indices; the node mints attribute IDs per call and rewrites at use time.
- `TVFAdvertisement` — bag of optional fields, each a static value or a `TVFAdvertiseFn<T>`: `isSet`, `keys`, `fds`, `equivClasses`, `ordering`, `monotonicOn`, `monotonicOnColumns`, `constantBindings`, `estimatedRows`, `accessCapabilities`, `deterministic`, `readonly`, `idempotent`.
- `resolveAdvertisement(spec, operands, schema)` — resolves a value-or-closure to a concrete value; tolerates throwing closures (returns `undefined`).
- `evaluateLiteralOperand(operand)` — returns `operand.expression.value` when the operand is a literal `ScalarPlanNode`, else `undefined`.
- `TableValuedFunctionSchema.relationalAdvertisement?: TVFAdvertisement` — optional, no default ⇒ pre-existing TVFs behave exactly as before.

### Registration (func/registration.ts)

`TableValuedFuncOptions` gained `relationalAdvertisement?: TVFAdvertisement`. Both `createTableValuedFunction` and `createIntegratedTableValuedFunction` forward it onto the produced schema. Absent ⇒ no advertisement.

### Plan-node wiring (planner/nodes/table-function-call.ts)

- `getType()` now consults the resolved `isSet` and `keys` advertisements (when valid) and folds them into a new `RelationType`. Falls back to the schema's `returnType.isSet`/`returnType.keys` when not advertised or when validation fails. Cached.
- `computePhysical()` is now overridden. With no advertisement: returns `{ deterministic (from FunctionFlags), readonly: true, idempotent: true }`. With an advertisement: resolves and validates each facet, populates the corresponding `PhysicalProperties` fields, and translates `monotonicOnColumns` → `monotonicOn` by looking up the live attribute ID from `getAttributes()`. `monotonicOn` and `monotonicOnColumns` merge by attrId so both can coexist.
- `estimatedRows` getter now prefers `physical.estimatedRows`, falling back to the previous default of 10.
- Per-field validators are private functions in the same file using `createLogger('planner:tvf')`. On failure, the field is dropped silently with a single warning; the rest of the advertisement still applies. Validators cover: key column-index range, FD shape and indices, equivalence-class size (≥ 2) and indices, ordering range and duplicates, `monotonicOn` attrId membership, `monotonicOnColumns` range, constant-binding column range. `resolveAdvertisement` also catches closures that throw — a broken `TVFAdvertiseFn` never breaks planning.

### Built-in annotations

| TVF | Advertised |
|---|---|
| `generate_series` | `isSet`, `keys=[[0]]`, `ordering=[{0, asc}]`, `monotonicOnColumns=[{0, asc, strict}]`, `estimatedRows` from literal bounds, `deterministic`. |
| `json_each` | `isSet`, `keys=[[4]]` (id), `deterministic`. |
| `json_tree` | `isSet`, `keys=[[4]]` (id), `deterministic`. |
| `query_plan` | `isSet`, `keys=[[0]]` (id), `deterministic`. |
| `table_info` | `isSet`, `keys=[[0]]` (cid). |
| `index_info` | `isSet`, `keys=[[0, 1]]` (index_name, seq). |
| `foreign_key_info` | `isSet`, `keys=[[0, 10]]` (id, seq). |
| `unique_constraint_info` | `isSet`, `keys=[[0, 2]]` (id, seq). |
| `check_constraint_info` | `isSet`, `keys=[[0]]` (id). |
| `assertion_info` | `isSet`, `keys=[[0]]` (name). |
| `function_info` | `isSet`, `keys=[[0, 1]]` (name, num_args). |

Trace TVFs (`execution_trace`, `row_trace`, `stack_trace`, `scheduler_program`, `schema_size`, `explain_assertion`, `schema`) are intentionally not annotated — they are non-deterministic or lack a clean key.

### Tests

`packages/quereus/test/planner/tvf-physical-properties.spec.ts` covers:

- `generate_series(1, 100)` folds to a `TableLiteral` with the advertised 100 rows (verifies advertisement propagates into the const-fold result).
- `generate_series(1, ?)` keeps the `TableFunctionCall` and exposes `uniqueKeys`, `ordering`, `monotonicOn(strict, asc)`; `estimatedRows` is correctly omitted when an operand is a parameter.
- `monotonicOn` survives even when a Sort sits above the TVF (documenting that no general "Sort on monotonic source ⇒ eliminate" rule exists yet — left as a TODO note rather than expanding scope).
- `SELECT DISTINCT id FROM json_each(?)` — Distinct elimination kicks in because of the advertised key.
- `json_tree(?)` exposes `uniqueKeys=[[4]]`.
- FD-from-injective-projections flows through: `SELECT value + 1 AS v FROM generate_series(1, ?)` gives the projected Project a singleton key on v.
- Negative case: a synthetic TVF with `keys=[[{index:99}]]` runs correctly, advertises no `uniqueKeys`, and emits a single warning.
- `properties` JSON still exposes the TVF column list.

### Docs

- `docs/optimizer.md` — new "TVF Property Declarations" subsection under Physical Properties System covering the advertisement surface, `monotonicOnColumns` rationale, `evaluateLiteralOperand`, the silent-validation policy, and the built-in annotation table.
- `docs/architecture.md` — Recent refinements gains a bullet pointing at the new section.

## Validation

- `yarn workspace @quereus/quereus run build` — passes (no TS errors).
- `yarn workspace @quereus/quereus run test` — 2811 passing, 2 pending (same as baseline). New spec contributes 8 passing tests.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn build` (root, all packages incl. CLI/web/vscode) — passes.

## What to verify in review

1. **Schema surface ergonomics** — is `TVFAdvertisement` the right shape? In particular, should `monotonicOn` (raw form) stay alongside `monotonicOnColumns`, or is the column form sufficient? Today both exist; the node merges them by attrId.
2. **Validation severity** — bad advertisements drop silently (single warning). Is that the right policy versus throwing during planning?
3. **`getType()` mutation** — the advertisement can override `returnType.isSet` and `returnType.keys` via `getType()` without mutating the schema. Double-check that consumers reading `getType()` for keys/isSet don't expect the original schema verbatim.
4. **`evaluateLiteralOperand`** — peeks at `expression.value` when `expression.type === 'literal'`. Verify this matches `LiteralNode`'s shape in `planner/nodes/scalar.ts` (it does; `LiteralExpr.value` is the SqlValue).
5. **`monotonicOnColumns` translation** — the node walks `getAttributes()[m.column]` and uses `.id` as the attrId. Strict default is `false` per the type definition.
6. **Built-in keys** — verify the key columns I picked for each schema TVF are actually unique within the result; I double-checked the column index for each.
7. **Sort elimination gap** — no rule yet picks up TVF-advertised `monotonicOn` to elide a downstream Sort (rule-monotonic-limit-pushdown wants ordinalSeek + LIMIT; rule-grow-retrieve targets RetrieveNode). The spec documents this as future work.

## Out of scope (per ticket)

- vtab-style `getBestAccessPlan` from a TVF.
- Runtime parameter-dependent advertisements (closures only fire at planning time today).
- Auto-inferring advertisements from the JS implementation body.

## End
