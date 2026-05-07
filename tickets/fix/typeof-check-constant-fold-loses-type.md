description: typeof(x) inside a CHECK predicate yields false because the planner inserts an implicit cast on the right-hand literal and constant-folds it to 0
files:
  packages/quereus/src/func/builtins/scalar.ts
  packages/quereus/src/func/registration.ts
  packages/quereus/src/runtime/emit/binary.ts
  packages/quereus/src/planner/analysis/const-pass.ts
  packages/quereus/test/logic/40.2-check-extras.sqllogic
----

## Problem

`packages/quereus/test/logic/40.2-check-extras.sqllogic` exercises a CHECK
that reads `typeof(x)`:

```sql
create table t_typ (
    id integer primary key,
    x any,
    check (typeof(x) in ('integer', 'real'))
);
insert into t_typ values (1, 10);
```

The corpus expects the insert to succeed and then `select typeof(x)` to
return `'integer'`. The file appears to pass under upstream's
`mocha + ts-node` runner (`packages/quereus/test/logic.spec.ts`), but the
exact same scenario fails when the same compiled Quereus is consumed via
`vitest` (downstream e.g. `lamina-quereus-test`):

```
ConstraintError: CHECK constraint failed: _check_0 (typeof(x) = 'integer')
  at throwForAction (constraint-check.ts:59)
  at checkCheckConstraints (constraint-check.ts:347)
```

Reproducible against the bare `MemoryTableModule` (no overlay, no
isolation, no third-party vtab). The CHECK clause variants

  - `check (typeof(x) = 'integer')`
  - `check (typeof(10) = 'integer')`
  - `check (typeof(x) in ('integer', 'real'))`

all reject every insert in vitest. The plain `select typeof(x)` query
returns `'integer'` correctly — only CHECK enforcement is affected.

## Root cause

`typeofFunc` (`packages/quereus/src/func/builtins/scalar.ts:160`) is
registered with no explicit `returnType`. `createScalarFunction`
(`packages/quereus/src/func/registration.ts:96`) defaults the return
type to `REAL_TYPE`:

```ts
const returnType: ScalarType = options.returnType ?? {
    typeClass: 'scalar',
    logicalType: REAL_TYPE,
    nullable: true,
    isReadOnly: true
};
```

So the planner believes `typeof(x)` returns a numeric value. When
emitting the `=` comparator (`runtime/emit/binary.ts:222-246`) the
planner reads `leftType.logicalType.isNumeric === true` and selects a
path that coerces the right-hand text literal `'integer'` to REAL via
an implicit `Cast` node. That `Cast('integer' AS REAL)` is then a
const-foldable subtree (its operand is a literal), so the
`const-pass.ts` border-replacement pass evaluates it to `0` and
substitutes a `LiteralNode(value: 0)`. At runtime the comparison
becomes `'integer' (string from typeof) = 0 (number from folded
cast)` → `false` → CHECK fails.

Captured live (instrumented `replaceBorderNodes` and `typeofFunc`):

```
[CONST-FOLD] node=Cast id=11 value=0
[TYPEOF DEBUG] arg=10 (typeof=number) -> integer
```

— the right-hand literal is folded to 0 before the CHECK runs;
typeof is then called once at constraint-eval time and correctly
returns `'integer'`, which doesn't match.

## Why upstream's mocha test still reports green

The bug only surfaces when the planner's constant-fold pass runs on the
implicit cast. Empirically that happens under vitest (which loads the
compiled `dist/` JS) but not under mocha+ts-node loading the TypeScript
source — likely an order-of-evaluation / specifier-resolution
difference in how the cast vs. the literal arrive at
`classifyConstants`. Either way the buggy plan shape is reachable;
the corpus test silently relies on the unfolded path. Adding the
explicit return type below makes both paths admit the CHECK without
folding the right-hand side.

## Hypothesis (fix shape)

Pin `typeof()`'s return type to TEXT in its registration so the `=`
comparator never inserts the lossy cast:

```ts
export const typeofFunc = createScalarFunction(
    {
        name: 'typeof',
        numArgs: 1,
        deterministic: true,
        returnType: {
            typeClass: 'scalar',
            logicalType: TEXT_TYPE,
            nullable: false,
            isReadOnly: true,
        },
    },
    (arg: SqlValue): SqlValue => getSqlDataTypeName(arg)
);
```

This matches SQLite's documented behaviour (`typeof()` returns one of
`'null' | 'integer' | 'real' | 'text' | 'blob'` — a TEXT result) and
removes the false numeric affinity that drives the cast.

A complementary cleanup for `scalar.ts` is to audit the other
text-returning scalars registered without explicit return type
(`coalesce`, `printf`, etc.) for the same latent bug.

## Reproduction

A focused vitest reproducer (no lamina / no isolation, just
`MemoryTableModule`):

```ts
import { Database, MemoryTableModule } from '@quereus/quereus';
import { describe, expect, it } from 'vitest';

describe('typeof CHECK', () => {
    it('typeof(x) = literal accepts the insert', async () => {
        const db = new Database();
        db.setOption('default_vtab_module', 'memory');
        await db.exec(
            "create table t (id integer primary key, x any, check (typeof(x) = 'integer'));" +
            "insert into t values (1, 10);"
        );
        await db.close();
    });
});
```

Currently throws `CHECK constraint failed: _check_0 (typeof(x) =
'integer')`.

## Downstream impact

`lamina-quereus-test/src/sqllogic/known-failures.ts` carries this file
under `TYPEOF_CHECK_CONSTANT_FOLD` after
`lamina-relational-typeof-check-function` cleared the schema-admission
half. Removing the entry on the lamina side requires this fix.

## TODO

- Pin `typeof()`'s `returnType` to TEXT in `scalar.ts`.
- Add a `40.2-check-extras`-aligned vitest-runnable spec to upstream so
  the green/red split between mocha+ts-node and vitest+dist disappears.
- Audit `string.ts` / `scalar.ts` for other text-returning scalars
  registered without an explicit return type.
- Once landed, downstream
  `lamina-quereus-test/src/sqllogic/known-failures.ts` removes the
  `TYPEOF_CHECK_CONSTANT_FOLD` entry.
