description: Runtime RESTRICT pre-check (`assertNoRestrictedChildrenForParentMutation`) added as a backend-agnostic safety net for parent-side FK enforcement. Mirrors `assertNoReferencingChildrenForDrop`'s shape (direct `select 1 ... limit 1` against the child) and fires from `runDelete` / `runUpdate` in `runtime/emit/dml-executor.ts` before `vtab.update()`. The plan-time `NOT EXISTS` check in `buildParentSideFKChecks` remains the primary path; the runtime pass is defense-in-depth for vtab modules where the embedded subquery's evaluation diverges from a plain row scan.
files:
  packages/quereus/src/runtime/foreign-key-actions.ts
  packages/quereus/src/runtime/emit/dml-executor.ts
  packages/quereus/test/runtime/fk-restrict-runtime.spec.ts
  docs/sql.md
----

## What landed

### Runtime RESTRICT pre-check
`runtime/foreign-key-actions.ts` exports a new `assertNoRestrictedChildrenForParentMutation(db, parentTable, operation, oldRow, newRow?)`:

- iterates `db.schemaManager._getAllSchemas()` to find every FK pointing at `parentTable`
- only fires for the matching `operation` × `'restrict'` pair (DELETE or UPDATE × `onDelete`/`onUpdate`)
- on UPDATE, skips when no referenced parent column actually changed (MATCH SIMPLE: `sqlValuesEqual` on each `parentColIndices[i]`)
- skips when any old referenced value is NULL (MATCH SIMPLE: NULL parent values cannot be referenced)
- builds `select 1 from <child> where <fk1> = ? and ... limit 1` using `quoteIdentifier` and runs it via `db.prepare` + `_iterateRowsRaw` — same shape `assertNoReferencingChildrenForDrop` uses for the DROP TABLE guard
- throws `QuereusError(StatusCode.CONSTRAINT, "FOREIGN KEY constraint failed: <op> on '<parent>' violates RESTRICT from '<child>'")` on a hit

### DML executor wiring
`runtime/emit/dml-executor.ts`:

- `runDelete` calls the new pre-check immediately before `vtab.update()` for every emitted row
- `runUpdate` does the same, passing the `newRow` so the function can short-circuit on no-op-on-referenced-column updates
- the existing `executeForeignKeyActions` call remains AFTER `vtab.update()` for CASCADE / SET NULL / SET DEFAULT

### Why two layers
The plan-time check (`buildParentSideFKChecks` synthesizes `NOT EXISTS` and embeds it as an `'fk-parent'` `RowConstraintSchema`) is the primary enforcement path. The runtime pass exists because some vtab modules evaluate the embedded correlated subquery differently from a plain row scan — predicate-pushdown quirks, isolation-snapshot interactions, or in some downstreams a custom FK validator that rejects/swallows the operation before the upstream check runs. The two paths together mean any backend that exposes the standard `prepare`/`iterate` interface honours RESTRICT.

### Doc update
`docs/sql.md` § FK enforcement semantics: clarified that parent-side RESTRICT runs both layers (plan-time `NOT EXISTS` + runtime `select ... limit 1`), MATCH SIMPLE, and skip-on-no-change-on-UPDATE.

## Tests landed

`test/runtime/fk-restrict-runtime.spec.ts` (8 cases):

1. DELETE on UNIQUE-non-PK target — referenced row throws, unreferenced row succeeds
2. DELETE on PK target — same behaviour, ensures PK target shape still works
3. UPDATE that changes the referenced UNIQUE column throws
4. UPDATE that touches an unrelated column does not fire the check (`label` change with `code` unchanged)
5. `pragma foreign_keys = false` disables both layers
6. CASCADE bypasses RESTRICT entirely (cascading delete clears the child)
7. **Direct call** to `assertNoRestrictedChildrenForParentMutation` with referenced parent values throws — covers the function in isolation, the path that fires when a vtab's plan-time NOT EXISTS would otherwise miss
8. **Direct call** with unreferenced parent values returns cleanly

The direct-call cases (#7, #8) are the unit-test coverage the source ticket asked for — they exercise the runtime check against the standard `prepare`/`iterate` query interface, the same interface any third-party vtab module would expose.

## Validation

- `yarn workspace @quereus/quereus run typecheck` — clean (exit 0)
- `yarn workspace @quereus/quereus test` — 2713 passing, 2 pending, 0 failing
- `yarn workspace @quereus/quereus run test:store` — 562 passing, 2 pending, 1 pre-existing failure (`10.5.1-partial-indexes.sqllogic` UNIQUE-on-partial-index — unrelated to this ticket and present at HEAD before the change)
- `yarn workspace @quereus/quereus run lint` — clean (exit 0)
- `yarn workspace @quereus/quereus run build` — clean (exit 0)
- `41-fk-extended-targets.sqllogic` — passes against memory and store backends

## Use cases

1. **Parent DELETE with UNIQUE-column FK target.** `delete from p_uq where code = 'AAA'` with `c_uq.p_code references p_uq(code) on delete restrict` and a referencing child row → CONSTRAINT error.
2. **Parent DELETE with PK target.** Same shape on a PK-targeted FK.
3. **Parent UPDATE that touches a referenced column.** `update p_uq set code = 'BBB' where id = 1` with `on update restrict` → CONSTRAINT error.
4. **Parent UPDATE that does not touch the referenced column.** `update p_uq set label = 'x' where id = 1` succeeds even with `on update restrict` and a referencing child row.
5. **CASCADE / SET NULL / SET DEFAULT.** Unaffected — handled by the existing post-`vtab.update` `executeForeignKeyActions` walker.
6. **`pragma foreign_keys = off`.** No-op (both layers gated on the pragma).

## Out of scope / downstream residual

The lamina-on-quereus `41-fk-extended-targets.sqllogic` entry in `lamina/packages/lamina-quereus-test/src/sqllogic/known-failures.ts` cannot yet be retired. Diagnosis under triage:

- Lamina-relational's `evaluateFks` (`packages/lamina-relational/src/constraint.ts:312-325`) calls `context.presence.rowExists(fk.refTable, refKey)` where `refKey` is built from the child's FK column values. `presence.rowExists` looks the parent up by primary key — when the FK references a UNIQUE non-PK column whose declared type differs from the parent PK's type, the cellstore codec throws `ValueCodecError: int: expected number | bigint, got string` before the INSERT lands.
- Net effect on the sqllogic harness: line 21's `insert into c_uq values (10, 'AAA')` fails inside lamina's FK validator. The runner's empty `-- error:` substring on line 25 swallows the error, but the INSERT didn't actually succeed — so `c_uq` is empty when line 28's `delete from p_uq where code = 'AAA'` runs. Both the upstream plan-time `NOT EXISTS` and the new runtime `select ... limit 1` correctly find no referencing child rows; the DELETE succeeds; the test fails on line 29's expected error.
- Fix belongs in lamina-relational: `evaluateFks` must look the parent up by the FK's `refColumns` (the actual referenced columns, which may be PK or a UNIQUE non-PK index), not by the parent's PK. A new lamina-side ticket should track that. Once lamina's INSERT path correctly accepts the row, this upstream change is sufficient — the runtime pre-check (and the plan-time check) will trip the DELETE.

## Notes for the reviewer

- The runtime check is intentionally redundant with the plan-time check for the memory and store backends. The micro-cost (one prepared `select 1 ... limit 1` per row deleted/updated when at least one inbound RESTRICT FK exists) is acceptable for the consistency guarantee. If profiling later shows it as a hotspot, gating the runtime pass behind a pragma or skipping when the plan-time check is known to be sound is straightforward.
- `assertNoRestrictedChildrenForParentMutation` does not skip self-FKs (unlike `assertNoReferencingChildrenForDrop`, which does). For per-row DELETE/UPDATE, a self-referencing row from a DIFFERENT row should still trigger RESTRICT. The unit test does not cover self-FK + DELETE explicitly; consider adding if reviewer wants stronger coverage.
- Function is exported and used in tests directly to verify behaviour without needing to construct a custom vtab module. The standard `db.prepare` / `_iterateRowsRaw` path it uses IS the standard third-party vtab interface — any module that exposes a working query path gets correct enforcement.
