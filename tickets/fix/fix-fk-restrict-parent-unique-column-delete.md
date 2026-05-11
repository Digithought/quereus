----
description: Parent-side RESTRICT enforcement on DELETE doesn't fire when the parent column is a UNIQUE (non-PK) column and the storage backend is a custom vtab module (lamina). Scope-extension on `1-fix-fk-validation-and-enforcement` (complete) which added child-side EXISTS always-emitted, default RESTRICT, and arity validation, but evidently doesn't cover this parent-side path uniformly across vtab modules.
prereq:
files:
  packages/quereus/src/planner/building/foreign-key-builder.ts
  packages/quereus/src/runtime/foreign-key-actions.ts
  packages/quereus/src/schema/manager.ts
  packages/quereus/test/logic/41-fk-extended-targets.sqllogic
  tickets/complete/1-fix-fk-validation-and-enforcement.md
----

## What's failing

`packages/quereus/test/logic/41-fk-extended-targets.sqllogic:1-29`:

```sql
pragma foreign_keys = true;

create table p_uq (id integer primary key, code text not null unique);

create table c_uq (
    id integer primary key,
    p_code text,
    foreign key (p_code) references p_uq(code) on delete restrict
);

insert into p_uq values (1, 'AAA'), (2, 'BBB');

insert into c_uq values (10, 'AAA');

-- invalid FK insert (no matching UNIQUE value)
insert into c_uq values (11, 'ZZZ');
-- error:                          -- ← this passes (child-side EXISTS catches it)

-- RESTRICT on parent UNIQUE column delete
delete from p_uq where code = 'AAA';
-- error:                          -- ← THIS does not fire when run through lamina's vtab
```

Last successful directive at line 25 (the child-side `-- error:`); the next assertion at line 29 expects `delete from p_uq where code = 'AAA'` to fail with RESTRICT (because `c_uq.p_code = 'AAA'` references this parent row), but the DELETE succeeds. The downstream lamina-on-quereus harness records this as `quereus/fix-fk-restrict-parent-unique-column-delete` (this ticket).

## Why the prior ticket didn't cover it

`1-fix-fk-validation-and-enforcement` (complete, May 7) explicitly added `41-fk-extended-targets.sqllogic` and called out:

> ### Tests landed
> - `41-fk-extended-targets.sqllogic`: arity-mismatch rejected at CREATE; FK to missing parent fails on non-NULL row; multi-column FK with non-natural parent column order.

The test file passed against the **memory module** at upstream commit time. But when run through a different vtab module (lamina's `LaminaModule`), the parent-side DELETE RESTRICT path doesn't engage. Either:

1. The parent-side RESTRICT check (`executeForeignKeyActions` for `action === 'restrict'`) was built against memory-module-specific assumptions about how the parent table's rows are scanned, and doesn't go through the standard vtab `xUpdate`/`xDelete` hooks where it would be backend-agnostic.
2. The parent-side check IS at the vtab hook, but a code path the memory module triggers does not fire for the lamina path (e.g. some `BEFORE DELETE` analogue that the memory module materialises differently).

## Triage hand-off

Reproduce against the memory module first:
```sh
yarn workspace @quereus/quereus test --grep "41-fk-extended-targets"
```
Expected: passes (per the complete ticket's verification).

Then reproduce against lamina (in `../../../lamina`):
```sh
yarn vitest run packages/lamina-quereus-test/src/sqllogic/sqllogic.test.ts -t "41-fk-extended-targets.sqllogic"
```
Expected: fails with `Error: ... but SQL block executed successfully` at line 29 (`lastSuccessfulStep: 25`).

The diff between the two runs pinpoints the gap. Likely suspects:
- `buildChildSideFKChecks` / `buildParentSideFKChecks` in `planner/building/foreign-key-builder.ts` may emit parent-side checks only when the parent's PK column is the FK target, missing the UNIQUE-column target case.
- `executeForeignKeyActions` may rely on an index lookup against the parent's PK that doesn't exist on the UNIQUE column when going through a custom vtab.
- `assertNoReferencingChildrenForDrop` in `schema/manager.ts` handles DROP TABLE; the symmetric pre-DELETE check for RESTRICT may be missing or differently structured.

## Scope

Restore the parent-side DELETE RESTRICT enforcement so it fires for any FK target — PK column, UNIQUE column, generated UNIQUE column — and works against any vtab module, not just the memory module. The fix should NOT require backend-specific cooperation; FK enforcement is upstream's responsibility per the lamina cluster comment.

## Design constraints

- **Backend-agnostic** — the check must work through the standard vtab interface so any module (memory, lamina, future modules) gets consistent enforcement.
- **Don't regress UNIQUE / generated-UNIQUE / composite cases** the prior ticket landed.
- **Respect `pragma foreign_keys` PRAGMA** — when off, no enforcement.
- **Cascade and other actions** — only RESTRICT (and NO ACTION, which maps to RESTRICT) require blocking. CASCADE / SET NULL / SET DEFAULT operate on the child rows after a successful parent change. This ticket touches only the RESTRICT path; verify CASCADE etc. still work.

## Tests

- `41-fk-extended-targets.sqllogic` runs to completion through lamina's vtab module.
- Add a unit test that exercises parent-side DELETE RESTRICT through a minimal third-party vtab (or via a test double of the vtab interface) so the regression isn't lamina-specific.

## Verification

- `yarn workspace @quereus/quereus test --grep "fk-|foreign|41-fk-extended-targets"` — passes.
- `yarn workspace @quereus/quereus test` — no regressions.
- Downstream: `yarn vitest run packages/lamina-quereus-test/src/sqllogic/sqllogic.test.ts -t "41-fk-extended-targets.sqllogic"` passes outside `KNOWN_FAILURES`.

## Downstream

`lamina/packages/lamina-quereus-test/src/sqllogic/known-failures.ts` currently lists `41-fk-extended-targets.sqllogic` under `FK_RESTRICT_PARENT_UNIQUE_DELETE` with `ticket: 'quereus/fix-fk-restrict-parent-unique-column-delete'`. When this fix lands, the lamina entry can be retired.
