---
description: UPDATE path in `dml-executor.ts` drops `result.replacedRow`. When a column-level (or `OR REPLACE`) PK-change UPDATE evicts an existing row at the new PK, the displaced row is invisible to change tracking, FK cascade, and auto-events. Mirror the INSERT path's `replacedRow` handling, additionally adding a DELETE record/cascade/event for the evicted row.
prereq:
files:
  packages/quereus/src/runtime/emit/dml-executor.ts
  packages/quereus/src/vtab/memory/layer/manager.ts
  packages/quereus/test/logic/29.1-column-level-conflict-clause.sqllogic
---

## Root cause

`packages/quereus/src/vtab/memory/layer/manager.ts:649-661`
(`performUpdateWithPrimaryKeyChange`) already returns
`{ status: 'ok', row: newRowData, replacedRow: existingRowAtNewKey }`
when an UPDATE moves a row onto an occupied PK under REPLACE. The
executor at `packages/quereus/src/runtime/emit/dml-executor.ts:506-545`
only reads `result.row`, so the displaced row is invisible to:

- `ctx.db._recordUpdate(...)` — change tracking sees the move
  `(oldRow → newRow)` but not the deletion of the evicted row.
- `executeForeignKeyActions(db, table, 'update', oldRow, newRow)` — FK
  CASCADE/SET NULL/SET DEFAULT runs for the moved row but never for the
  evicted row's children.
- `emitAutoDataEvent(...)` — non-native-event modules see one `update`
  but no `delete` for the evicted row.

The INSERT path at `dml-executor.ts:422-446` already handles
`result.replacedRow`. The UPDATE path needs the analog plus an extra
DELETE record for the evicted row (the INSERT path doesn't need this
because the slot at PK_new holds the new row after the replace, and the
single `_recordUpdate(replacedRow → newRow)` covers that transition).

## Implementation approach

Follow the ticket's allowed two-event collapse: keep the existing
`_recordUpdate(oldRow, newRow, …)` for the moved row, and **add** a
DELETE for the evicted row on top.

After the existing post-success block at `dml-executor.ts:518-543`
(after `_recordUpdate`, `executeForeignKeyActions('update', …)`, and the
auto-event emission), insert handling for `result.replacedRow`:

```ts
if (result.replacedRow) {
    const evictedKeyValues = pkColumnIndicesInSchema.map(idx => result.replacedRow![idx]);
    ctx.db._recordDelete(
        `${tableSchema.schemaName}.${tableSchema.name}`,
        result.replacedRow,
        pkColumnIndicesInSchema,
    );
    await executeForeignKeyActions(ctx.db, tableSchema, 'delete', result.replacedRow);
    if (needsAutoEvents) {
        emitAutoDataEvent(ctx, tableSchema, 'delete', evictedKeyValues, [...result.replacedRow]);
    }
}
```

Notes:

- Derive the evicted row's PK from `result.replacedRow` itself rather
  than reusing `newRow`'s PK — they are equal in the memory module's
  current implementation, but extracting from `replacedRow` is the
  correct invariant if a future vtab module returns a different layout.
- Emit the eviction-DELETE **after** the existing UPDATE bookkeeping so
  later observers see the natural sequence: the move first, then the
  side-effect deletion of the row that had to be displaced. (Either
  order satisfies the ticket; pick post-update to match how the memory
  module's layer journals it: `recordDelete(newPk, evicted)` runs before
  the move in the vtab, but the executor records the move as the
  primary semantic operation.)

## Test additions

Append to `packages/quereus/test/logic/29.1-column-level-conflict-clause.sqllogic`:

### Section 9 — FK cascade fires for the evicted row

```sql
create table parent_evict (id integer primary key on conflict replace, v text);
create table child_evict (
    id integer primary key,
    parent_id integer references parent_evict(id) on delete cascade
);
insert into parent_evict values (1, 'one'), (2, 'two');
insert into child_evict values (10, 1), (20, 2);

-- Move parent id=1 onto id=2; column-level REPLACE evicts the row at id=2.
update parent_evict set id = 2 where id = 1;

-- The row formerly at id=2 was evicted, so its child (id=20) must be cascaded.
select id, parent_id from child_evict order by id;
→ [{"id":10,"parent_id":2}]

select id, v from parent_evict order by id;
→ [{"id":2,"v":"one"}]

drop table child_evict;
drop table parent_evict;
```

### Section 10 — FK ON DELETE SET NULL for the evicted row

```sql
create table p_set_null (id integer primary key on conflict replace, v text);
create table c_set_null (
    id integer primary key,
    parent_id integer references p_set_null(id) on delete set null
);
insert into p_set_null values (1, 'a'), (2, 'b');
insert into c_set_null values (100, 1), (200, 2);

update p_set_null set id = 2 where id = 1;

select id, parent_id from c_set_null order by id;
→ [{"id":100,"parent_id":2},{"id":200,"parent_id":null}]

drop table c_set_null;
drop table p_set_null;
```

If exposing the data-event stream from the sqllogic harness is
non-trivial, leave the auto-event side covered indirectly by the FK
cascade tests (cascade goes through `executeForeignKeyActions`, which
shares the same gate as `_recordDelete`) and document in the review
ticket that a dedicated event-emission test should be added at a higher
level (e.g. a unit test against `DatabaseEventEmitter` in
`packages/quereus/test/`).

## TODO

- Edit `packages/quereus/src/runtime/emit/dml-executor.ts` UPDATE path:
  after the existing `_recordUpdate` / `executeForeignKeyActions` /
  auto-event block at lines 518-543, add the `result.replacedRow`
  handling described above.
- Append sections 9 and 10 to
  `packages/quereus/test/logic/29.1-column-level-conflict-clause.sqllogic`.
- Run `yarn workspace @quereus/quereus run test` and verify the new
  sections pass and nothing in the existing column-level-conflict suite
  regresses.
- If feasible without significant scope creep, add a test that
  subscribes to data events and verifies a `delete` event fires for the
  evicted row; otherwise, surface this as a deferral in the review
  handoff.
- Run `yarn workspace @quereus/quereus run lint` to catch any
  style/typing slips in the executor edit.
