---
description: Foreign key constraint enforcement with cascading actions
dependencies: Schema system, constraint pipeline, DML planner/emitter, parser
---

## Summary

Foreign key constraints are now fully enforced when `pragma foreign_keys = on`. The implementation spans parsing, schema storage, plan-time constraint synthesis, runtime constraint checking, and cascading action execution.

## What Was Done

### Bug Fixes (found during testing)

1. **Parser: column-level REFERENCES** — `foreignKeyClause()` consumed REFERENCES unconditionally, but `columnConstraint()` had already consumed it. Fixed to check before consuming, enabling column-level FK syntax: `col INTEGER REFERENCES parent(id) ON DELETE CASCADE`.

2. **RESTRICT immediate enforcement** — Parent-side RESTRICT checks were incorrectly deferred because `containsSubquery: true` overrode `deferrable: false` in the shouldDefer logic. Fixed by setting `containsSubquery: false` for RESTRICT checks in `foreign-key-builder.ts`.

3. **Cascading action SQL** — `foreign-key-actions.ts` used `?N` numbered parameter syntax not supported by the parser. Changed to positional `?` parameters. Also switched from `db.exec()` to `db._execWithinTransaction()` since cascading actions run within the parent's transaction.

4. **SET DEFAULT action** — `col.defaultValue` is always an AST Expression, but the code checked `typeof !== 'object'` for raw values. Fixed to use `expressionToString()` to stringify AST default expressions properly.

### Testing

Comprehensive test suite in `test/logic/41-foreign-keys.sqllogic`:
- Child-side INSERT/UPDATE validation (referencing non-existent parent fails)
- Parent-side RESTRICT on DELETE/UPDATE (immediately rejects when children exist)
- NO ACTION (deferred to commit; allows fixing within transaction)
- CASCADE DELETE (child rows automatically deleted)
- CASCADE UPDATE (child FK columns automatically updated)
- SET NULL (child FK columns set to NULL)
- SET DEFAULT (child FK columns set to default values)
- Pragma on/off behavior (enforcement disabled by default)
- Column-level FK syntax with ON DELETE CASCADE
- Cycle detection (simple cascade chains work)

### Documentation

- Updated `docs/sql.md` section 7.6 with enforcement semantics, pragma usage, and action descriptions
- Updated `docs/memory-table.md` limitations section to reflect current constraint enforcement state

## Key Files

- `packages/quereus/src/parser/parser.ts` — column-level REFERENCES fix
- `packages/quereus/src/planner/building/foreign-key-builder.ts` — RESTRICT immediate enforcement fix
- `packages/quereus/src/runtime/foreign-key-actions.ts` — cascading actions (param syntax, _execWithinTransaction, SET DEFAULT expression handling)
- `packages/quereus/test/logic/41-foreign-keys.sqllogic` — comprehensive FK test suite
- `docs/sql.md` — FK enforcement documentation
- `docs/memory-table.md` — updated limitations

## Validation

All 62 logic tests pass. Full test suite passes (1 pre-existing flaky property test for numeric affinity is unrelated).
