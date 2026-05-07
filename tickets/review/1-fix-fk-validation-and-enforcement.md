description: Review FK validation and enforcement fix — default FK action now `'restrict'` (was `'ignore'`), CREATE-TABLE FK aligned with ADD-COLUMN, child-side EXISTS check always emitted, child INSERT/UPDATE fails when parent table is missing on non-NULL FK, child/parent column-count parity validated at DDL time, DROP of FK-referenced parent blocked while children have rows, `'ignore'` removed from `ForeignKeyAction` type.
prereq:
files:
  packages/quereus/src/planner/building/foreign-key-builder.ts
  packages/quereus/src/schema/manager.ts
  packages/quereus/src/parser/parser.ts
  packages/quereus/src/parser/ast.ts
  packages/quereus/src/schema/table.ts
  packages/quereus/src/schema/catalog.ts
  packages/quereus/src/schema/schema-differ.ts
  packages/quereus/src/runtime/foreign-key-actions.ts
  packages/quereus/src/runtime/emit/alter-table.ts
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/test/logic/41-fk-extended-targets.sqllogic
  packages/quereus/test/logic/41-fk-cascade-conflict-and-self-ref.sqllogic
  packages/quereus/test/logic/41-foreign-keys.sqllogic
  packages/quereus/test/logic/06.3.2-schema-foreign-keys.sqllogic
  packages/quereus/test/logic/50-declarative-schema.sqllogic
----

## Summary of changes

### Phase A — FK enforcement defaults
- `extractForeignKeys` (`schema/manager.ts`): both code paths now default `onDelete`/`onUpdate` to `'restrict'`.
- `parseForeignKeyAction` (`parser/parser.ts`): `NO ACTION` now maps to `'restrict'` (was `'ignore'`).
- `buildChildSideFKChecks` (`planner/building/foreign-key-builder.ts`): the both-`'ignore'` skip is gone; child-side EXISTS is always emitted.
- `executeForeignKeyActions` (`runtime/foreign-key-actions.ts`): the `action === 'ignore'` arm is gone.
- `ForeignKeyAction` (`parser/ast.ts`): `'ignore'` removed from the union (unreachable from SQL after the parser change).
- Doc comments updated in `schema/table.ts` (`default: 'restrict'`).
- `foreignKeyActionToString` (`emit/ast-stringify.ts`): `'ignore'` case removed.
- `runtime/emit/alter-table.ts`: explanatory comment about both-`'ignore'` skip removed (no longer applies).

### Phase B — FK arity validation at DDL
- `extractForeignKeys` (`schema/manager.ts`): when `fk.columns` is provided, asserts that its length matches the child column count. Names the constraint and both arities in the error.
- `extractColumnLevelForeignKeys` (`runtime/emit/alter-table.ts`): same check for ADD COLUMN.

### Phase C — missing-parent FK enforcement
- `buildChildSideFKChecks` (`planner/building/foreign-key-builder.ts`): when the parent table is unresolved, builds a null-guards-OR-FALSE expression instead of skipping. MATCH SIMPLE still allows NULL FK rows; non-NULL rows now fail the synthetic constraint.

### Phase D — DROP TABLE blocked while children reference
- New private `assertNoReferencingChildrenForDrop` in `schema/manager.ts`. Called from `dropTable` before mutation. Skips when `foreign_keys` PRAGMA is off and skips self-FK (rows go away with the table). For each matching FK, runs `select 1 from <child> where <fk1> is not null and ... limit 1` via `db.prepare(...)._iterateRowsRaw()` (mirrors the existing `validateBackfillAgainstChecks` pattern in alter-table.ts). Throws `QuereusError(StatusCode.CONSTRAINT, ...)` on any matching row.

### Schema-declarative fallout (required by Phase D)
- `CatalogTable` (`schema/catalog.ts`): added `referencedTables: string[]` (same-schema only, self-FK excluded) so the differ can topologically sort drops.
- `computeSchemaDiff` / `orderDropsByFKDependency` (`schema/schema-differ.ts`): drops are now ordered children-before-parents via DFS post-order along child→parent edges, then reversed. Cycles bail out gracefully.

### Tests
- `41-fk-extended-targets.sqllogic`: uncommented the three TODO blocks (FK arity mismatch rejected at CREATE, FK to missing parent fails on non-NULL row, multi-column FK with non-natural parent column order).
- `41-fk-cascade-conflict-and-self-ref.sqllogic`: uncommented four TODO blocks (cascade-then-RESTRICT chain, self-referential composite FK, DROP TABLE of FK-referenced parent, DEFERRABLE INITIALLY DEFERRED column FK auto-commit). The INSERT OR IGNORE block at the top stays commented — it's a separate concern (the engine's IGNORE only suppresses UNIQUE conflicts, not FK violations) and warrants its own ticket.
- `41-foreign-keys.sqllogic`: rewrote the `NO ACTION` block to reflect the new (correct) RESTRICT semantics — the DELETE on a referenced parent now fails, deleting an unreferenced parent still succeeds.
- `06.3.2-schema-foreign-keys.sqllogic`: introspection expectation updated from `"ignore"` to `"restrict"`.
- `50-declarative-schema.sqllogic`: drop-order expectation updated to `comments`-before-`posts` (children first, matches the new differ behavior).

## Validation

- `yarn workspace @quereus/quereus run build` — passes (`tsc` exit 0).
- `yarn test` — full suite passes (655 passing, 0 failing in the logic suite; vitest packages pass too).
- `yarn workspace @quereus/quereus run lint` — clean (exit 0, no output).

## Use cases / behavior to verify under review

1. **Default FK actions enforce.** `create table c (x integer references p(id))` with no `ON DELETE`/`ON UPDATE` clauses: `insert into c values (<non-existent>)` errors; deleting a referenced parent row errors. (covered by 41-foreign-keys.sqllogic, 41-fk-extended-targets.sqllogic).
2. **`NO ACTION` is RESTRICT.** Mixed-clause FK declared with `ON DELETE NO ACTION`: behaves identically to `ON DELETE RESTRICT`. (41-foreign-keys.sqllogic NO ACTION block).
3. **Arity mismatch rejected at CREATE.** `foreign key (x) references mp(a, b)` and the column-level analogue both throw at CREATE-TABLE/ADD-COLUMN time with a clear constraint-and-arity message.
4. **Multi-column FK respects parent column order.** `foreign key (x, y) references mp2(b, a)` with `(x, y) = (100, 1)` finds parent `(b=100, a=1)`; `(x, y) = (1, 100)` errors. (41-fk-extended-targets.sqllogic block 7).
5. **Missing parent table fails non-NULL inserts.** `foreign key (p_id) references no_such_parent(id)` allows NULL p_id but rejects non-NULL. (41-fk-extended-targets.sqllogic block 6).
6. **Self-FK composite.** `tree (id, pid, tag, unique (id, tag), foreign key (pid, tag) references tree(id, tag))` accepts root self-match and valid children; rejects mismatched (pid, tag). (41-fk-cascade-conflict-and-self-ref.sqllogic block 5).
7. **DROP TABLE of FK-referenced parent.** Child rows present → `drop table parent` errors with `FOREIGN KEY constraint failed`. After dropping the child, parent drop succeeds. Self-FK does not block its own drop. (41-fk-cascade-conflict-and-self-ref.sqllogic block 6).
8. **Cascade-then-RESTRICT chain.** `update fa set id = N` cascades into fb, which is RESTRICTed by fc → end-to-end aborts atomically. (41-fk-cascade-conflict-and-self-ref.sqllogic block 3).
9. **DEFERRABLE INITIALLY DEFERRED column-level FK.** Auto-commit insert with no enclosing tx still rejects the violation; repeating the failing insert fails the same way (no dangling implicit tx). (41-fk-cascade-conflict-and-self-ref.sqllogic block 7).
10. **Schema differ drop ordering.** `apply schema` with FK-linked tables to drop produces children-first DDL; `diff schema main` reflects the same order. (50-declarative-schema.sqllogic step 15).

## Out of scope / follow-ups

- **`INSERT OR IGNORE` not silencing FK violations.** Block 1 of `41-fk-cascade-conflict-and-self-ref.sqllogic` remains commented; the runtime's IGNORE path only silences UNIQUE conflicts. Should be its own ticket.
- **Cross-schema FK drop ordering.** `referencedTables` in `CatalogTable` only tracks same-schema references. A multi-schema migration that drops parent in schema A and child in schema B simultaneously would not be ordered correctly. Not currently an exercised path.
- **Distinguish RESTRICT vs NO ACTION.** Both currently map to `'restrict'`. The plan calls this out explicitly: NO ACTION should defer to end-of-statement and currently fires immediately. Tests in our corpus pass both ways; introducing a separate `'noAction'` value is deferred until a test demands it.

## Code-review checklist

- Aspect-oriented (DRY, modular, error handling, perf): the new helper in `manager.ts` mirrors the existing `validateBackfillAgainstChecks` shape; `runtime/foreign-key-actions.ts` and the planner builder both lost their `'ignore'`-special-cases (simpler, not more complex). The new `orderDropsByFKDependency` is a small DFS, no allocation-heavy paths.
- Tests cover the seven bullets in the original `tickets/fix/1-...` ticket plus the schema-declarative drop-order regression that surfaced once Phase D started enforcing.
- No `any`, no inline `import()` (the moved-to-top `quoteIdentifier` import in `schema/manager.ts` and `actualTables` import in `schema/schema-differ.ts` are static; only one `import('./catalog.js').CatalogTable` remains as a type-only import in the differ helper, which is fine).
- Doc-comment defaults in `schema/table.ts` updated to `'restrict'`.
