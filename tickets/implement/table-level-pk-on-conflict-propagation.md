---
description: Propagate table-level `PRIMARY KEY (...) ON CONFLICT <action>` through schema build so PK conflicts honor the declared default (instead of silently degrading to ABORT). Adds a new `TableSchema.primaryKeyDefaultConflict` field consulted by the two `resolvePkDefaultConflict` helpers; column-level `defaultConflict` remains the fallback.
files:
  packages/quereus/src/schema/table.ts
  packages/quereus/src/schema/manager.ts
  packages/quereus/src/vtab/memory/layer/manager.ts
  packages/quereus-isolation/src/isolated-table.ts
  packages/quereus/test/logic/29.1-column-level-conflict-clause.sqllogic
prereq: isolation-honor-column-default-conflict
---

# Table-level `PRIMARY KEY ... ON CONFLICT <action>` propagation

## Background

`isolation-honor-column-default-conflict` wired column-level `defaultConflict`
through the three-tier resolution (`stmt OR > per-constraint default > ABORT`)
for the PK code path via two parallel helpers:

- `packages/quereus/src/vtab/memory/layer/manager.ts:1498` — `resolvePkDefaultConflict`
- `packages/quereus-isolation/src/isolated-table.ts:1329` — same shape, mirrored

Both inspect each PK column's `defaultConflict`. **Table-level** PK constraints
like `primary key (a, b) on conflict replace` parse correctly
(`TableConstraint.onConflict` is set) but the action is dropped in schema build
— `findConstraintPKDefinition`
(`packages/quereus/src/schema/table.ts:483`) returns
`PrimaryKeyColumnDefinition[]` without touching the constraint's `onConflict`,
and nothing else carries it forward. Result: PK conflicts fall through to
`ABORT`.

## Approach (option 2 from the fix ticket)

Add a top-level `TableSchema.primaryKeyDefaultConflict?: ConflictResolution`.
Mutating each PK column's `defaultConflict` (option 1) would conflate
column-level conflict semantics (violations of *that column's* constraints,
e.g. NOT NULL on that column) with PK-as-a-whole semantics, and would clobber
any column-level `ON CONFLICT` already declared. The new field keeps the two
concerns distinct.

### Resolution precedence (for PK conflicts only)

`statement OR` ⟶ `schema.primaryKeyDefaultConflict` (table-level) ⟶
column-level `defaultConflict` on any PK column ⟶ `ABORT`.

The new field is **stronger** than the column-level fallback because it is
the constraint's own declared action. A column-level `defaultConflict` on a
PK column is only ever a fallback for PK conflicts — its primary purpose is
NOT NULL / column-scoped constraints on that column, so it should not
override an explicit table-level declaration.

### Plumbing

`findPKDefinition` currently returns only `ReadonlyArray<PrimaryKeyColumnDefinition>`.
Two ways to surface the new value:

- Widen the return to `{ pkDef, defaultConflict }`. One caller
  (`schema/manager.ts:680` via `buildColumnSchemas`). Cleanest.
- Add a sibling exported function `findPKDefaultConflict(constraints)`. Less
  invasive but introduces a second AST walk over `constraints`.

Pick the first: single short call site, no duplicate walk. Update
`buildColumnSchemas` to return the conflict alongside `pkDefinition`, and
have the caller in `manager.ts` thread it into the constructed `TableSchema`.

### Helper update

Both `resolvePkDefaultConflict` helpers grow a first check:

```ts
function resolvePkDefaultConflict(schema: TableSchema): ConflictResolution | undefined {
    if (schema.primaryKeyDefaultConflict !== undefined) return schema.primaryKeyDefaultConflict;
    for (const def of schema.primaryKeyDefinition) {
        const col = schema.columns[def.index];
        if (col?.defaultConflict !== undefined) return col.defaultConflict;
    }
    return undefined;
}
```

Keep the two implementations identical (they already are, per the existing
comment in `isolated-table.ts`).

### `createBasicSchema`

`createBasicSchema` (`schema/table.ts:263`) builds a minimal schema and does
not parse `ON CONFLICT`. Leave `primaryKeyDefaultConflict` absent; nothing
in the basic-schema path declares it. Just ensure the optional field is
allowed when omitted (it is, since it's `?:`).

## Acceptance

- `create table t (a int, b int, primary key (a, b) on conflict ignore);
   insert into t values (1, 1), (1, 1);` → no error, single row.
- `create table t (..., primary key (...) on conflict replace);` → second
  conflicting insert silently replaces existing row.
- `create table t (..., primary key (...) on conflict fail);` → second insert
  errors (FAIL is the same surface as ABORT for a single-statement INSERT,
  but the statement must still error; rows already inserted in the same
  statement before the failure are kept — match existing FAIL semantics).
- `create table t (..., primary key (...) on conflict rollback);` → second
  insert errors and the surrounding transaction is rolled back.
- Statement-level `insert or abort ...` still overrides table-level IGNORE.
- Column-level `... primary key on conflict X` continues to work unchanged
  (existing 29.1 tests stay green).
- Plain memory module and `IsolationModule`-wrapped paths both pass.

## TODO

Schema plumbing
- Add `primaryKeyDefaultConflict?: ConflictResolution` to the `TableSchema`
  interface in `packages/quereus/src/schema/table.ts` (next to
  `primaryKeyDefinition`, with a short doc comment explaining the precedence
  rule). The field is intentionally absent from `createBasicSchema`'s frozen
  literal.
- Change `findConstraintPKDefinition` in `schema/table.ts` to additionally
  capture the matched constraint's `onConflict`. Return either a tuple or
  widen to an object — pick what reads cleanest given the single internal
  caller.
- Widen `findPKDefinition` (same file) to return
  `{ pkDef: ReadonlyArray<PrimaryKeyColumnDefinition>, defaultConflict: ConflictResolution | undefined }`.
  Column-level PK declarations carry no constraint-level `ON CONFLICT`
  (column-level `ON CONFLICT` lives in `ColumnSchema.defaultConflict`), so
  `defaultConflict` is `undefined` when only `columnPK` is set.
- Update the single caller `buildColumnSchemas` in
  `packages/quereus/src/schema/manager.ts:671` to forward the conflict
  alongside `pkDefinition`, and thread it into the constructed `TableSchema`
  at its call site (around `manager.ts:680`+ — locate the `Object.freeze({
  ... primaryKeyDefinition ... })` for the table schema and add
  `primaryKeyDefaultConflict: <value>`).

Helper updates
- `packages/quereus/src/vtab/memory/layer/manager.ts:1498` —
  `resolvePkDefaultConflict`: consult `schema.primaryKeyDefaultConflict`
  before iterating PK columns.
- `packages/quereus-isolation/src/isolated-table.ts:1329` — apply the same
  change. Keep the two implementations textually identical (matching the
  existing "Mirrors the helper" comment).

Tests
- Add a new logic test file
  `packages/quereus/test/logic/29.2-table-level-pk-conflict-clause.sqllogic`
  covering all four `ON CONFLICT` actions on a table-level composite PK:
  - `IGNORE` — duplicate insert silently dropped, one row remains.
  - `REPLACE` — duplicate insert silently replaces the existing row.
  - `FAIL` — duplicate insert errors with constraint failure.
  - `ROLLBACK` — duplicate insert errors and aborts the enclosing tx.
  - Plus: statement-level `insert or abort` overrides table-level `IGNORE`.
  - Plus: UPDATE path — `update ... set b = <conflicting>` honors table-level
    REPLACE / IGNORE (mirror cases 7 and 8 of 29.1 but with composite PK).
  Use the existing `→ [...]` assertion style from 29.1 for row checks and
  `-- error: ...` for expected errors.
- Run `yarn test` (memory backend) and `yarn test:store` (LevelDB store) to
  confirm both the plain memory module and the `IsolationModule`-wrapped
  paths pass. Stream output via `tee` per AGENTS.md.

Validation
- `yarn workspace @quereus/quereus run lint` (single-quote globs on Windows).
- `yarn build`.

## Notes for the implementer

- Don't propagate `constraint.onConflict` onto column `defaultConflict` —
  that conflates PK-level and column-level semantics and silently overwrites
  a column-level `ON CONFLICT` if both are declared.
- The fix lives entirely in the *schema-build* + *helper* layer. No planner
  or emit changes are needed: both `vtab/memory/layer/manager.ts` and
  `quereus-isolation/src/isolated-table.ts` already consult
  `resolvePkDefaultConflict` at insert / update PK-conflict sites
  (`manager.ts:562, 651`; `isolated-table.ts:630, 961`).
- `TableSchema` is widely consumed (see `primaryKeyDefinition` callers); the
  new field is optional and absent on existing code paths, so no other
  consumer needs to change.
