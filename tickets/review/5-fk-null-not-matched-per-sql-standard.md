description: MATCH SIMPLE NULL guards added to child-side FK constraint checks — NULL FK columns now satisfy the constraint without evaluating the EXISTS subquery.
dependencies: none
files:
  packages/quereus/src/planner/building/foreign-key-builder.ts
  packages/quereus/test/logic/41-foreign-keys.sqllogic
----

## What was built

`synthesizeExistsCheck()` in `foreign-key-builder.ts` now wraps the generated EXISTS expression with OR-chained `IS NULL` guards — one per FK column. The generated AST is:

```
(NEW.col1 IS NULL) OR (NEW.col2 IS NULL) OR ... OR EXISTS(SELECT 1 FROM parent WHERE ...)
```

This implements SQL:2016 §4.17.2 MATCH SIMPLE: the FK is satisfied immediately when any referencing column is NULL, without evaluating the EXISTS subquery.

No changes to parent-side checks (`synthesizeNotExistsCheck`) — parent PK columns are non-NULL by definition.

## Key test cases (in `41-foreign-keys.sqllogic`)

- **Empty parent + NULL child (RESTRICT)**: insert child with NULL FK and no parent rows — succeeds
- **Self-referential FK, first row NULL**: tree pattern with ON DELETE CASCADE, insert root with NULL parent_id — succeeds
- **Multi-column FK, one NULL column**: any single NULL in the FK column set satisfies MATCH SIMPLE — succeeds
- **Multi-column FK, all NULLs**: also satisfies — succeeds
- **Multi-column FK, no NULLs, no match**: must still fail (regression guard)
- All existing FK tests continue to pass (1917 total, 0 failures)

## Usage

No API changes. The fix is internal to FK constraint synthesis. Any nullable FK column that is NULL will now correctly pass the constraint check per the SQL standard.
