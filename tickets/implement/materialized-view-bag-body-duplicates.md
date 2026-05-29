description: A duplicate-producing "bag" materialized-view body (e.g. `select status from orders`) currently fails create/refresh with a raw `UNIQUE constraint failed: <hidden backing table> PK` error. Replace that with a purpose-built diagnostic that names the materialized view and explains the v1 set-semantics contract (a body needs a unique key). Decision: option 1 — an MV must be a set.
prereq:
files: packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/src/runtime/emit/materialized-view.ts, packages/quereus/src/vtab/memory/layer/manager.ts, docs/materialized-views.md, packages/quereus/test/logic/51-materialized-views.sqllogic
----

## Decision (settled in plan)

**Option 1 — clear diagnostic + documented set-semantics contract.** A v1
materialized view is a *keyed* derived relation: its body must produce a **set**
(no duplicate rows under the backing-table key). We do **not** silently de-dup
(option 3) and we do **not** add a synthetic row identity (option 2).

### Detection is dynamic, not static

The all-columns fallback PK is itself a legitimate *set* key: a keyless body
whose rows are all distinct (e.g. the existing `select y from pt` test at
`51-materialized-views.sqllogic:89`) materializes correctly today and must keep
working. The contract is violated only when the body actually emits a duplicate
row under the backing key. So enforcement stays where the collision is already
detected — at fill time — and we do **not** statically reject keyless bodies.

Consequences (already true today; this ticket only improves the *message*):
- A duplicate-producing body fails at `create` (loud, immediate).
- A body that is duplicate-free at create but becomes duplicate-producing after
  source edits fails at the next `refresh`. This late failure is inherent to the
  bag case under set semantics; the new diagnostic makes it self-explanatory
  rather than naming a hidden backing table. Documented as expected v1 behavior.

## Where the raw error comes from

`MemoryTableManager.replaceBaseLayer` (`manager.ts:1117`) builds a fresh
`BaseLayer`, inserting each row and throwing on the first duplicate primary key:

```
UNIQUE constraint failed: sqlite_mv_<name> PK.
```

That message names the *backing table*, not the MV, and reads like an internal
error. The same guard exists in `insertRow` (`manager.ts:1091`), but `insertRow`
is only used by the alter-table rekey path — **not** an MV fill path — so this
ticket leaves it alone.

The three MV fill paths that reach `replaceBaseLayer`:
1. **create** — `emitCreateMaterializedView` calls `manager.replaceBaseLayer(rows)`
   directly (`materialized-view.ts:57`).
2. **manual refresh** — `rebuildBacking` → `replaceBaseLayer`
   (`materialized-view-helpers.ts:205`).
3. **incremental global rebuild** — `database-materialized-views.ts` apply →
   `rebuildBacking` → `replaceBaseLayer`. (Keyless/bag bodies are
   incremental-ineligible, so this path should not see a bag body in practice,
   but it shares `rebuildBacking` and so inherits the better message for free.)

The btree's duplicate detection in `replaceBaseLayer` is collation/desc/composite
correct (it uses the real `primaryKeyFunctions.compare`). We want to keep that
single correct implementation and only swap the *message* — so a naive
pre-scan-with-a-`Set<string>` in the MV layer is rejected (it would miss
collation-equal collisions, e.g. `NOCASE`).

## Approach: caller-supplied duplicate-key error factory

Give `replaceBaseLayer` an optional error factory so the manager keeps its exact
(correct) detection while the MV layer owns the user-facing wording. The manager
stays generic — the parameter mentions duplicates, not materialized views.

```ts
// manager.ts
async replaceBaseLayer(
    rows: readonly Row[],
    onDuplicateKey?: () => QuereusError,
): Promise<void> {
    ...
    if (path.on) {
        throw onDuplicateKey
            ? onDuplicateKey()
            : new QuereusError(`UNIQUE constraint failed: ${this._tableName} PK.`, StatusCode.CONSTRAINT);
    }
    ...
}
```

A shared factory in `materialized-view-helpers.ts` keeps the message identical
across create and refresh:

```ts
/** Purpose-built diagnostic for a bag (duplicate-producing) MV body. */
export function materializedViewNotASetError(schemaName: string, viewName: string): QuereusError {
    return new QuereusError(
        `materialized view '${schemaName}.${viewName}' body produces duplicate rows, `
            + `but a materialized view must be a set: its body needs a unique key. `
            + `Add \`distinct\`, a \`group by\`/aggregation, or project a key column so every row is unique.`,
        StatusCode.CONSTRAINT,
    );
}
```

Wire it through both fill paths:
- `rebuildBacking(db, mv)` passes `() => materializedViewNotASetError(mv.schemaName, mv.name)`.
- `emitCreateMaterializedView` passes `() => materializedViewNotASetError(plan.schemaName, plan.viewName)`.

`StatusCode.CONSTRAINT` is retained so create's existing all-or-nothing rollback
(`materialized-view.ts:58-64` drops the backing table on any throw) and refresh
semantics are unchanged — only the message differs.

> Lighter alternative considered and rejected: catch the `CONSTRAINT` error
> from `replaceBaseLayer` in the MV layer and re-wrap it. It avoids touching the
> manager signature but relies on the brittle invariant that `replaceBaseLayer`
> only ever throws `CONSTRAINT` for the dup-PK case, and uses an exception as a
> control-flow signal (against AGENTS.md guidance). The factory is preferred.

## Test plan (key cases + expected output)

Extend `packages/quereus/test/logic/51-materialized-views.sqllogic` (sqllogic
matches `-- error: <substring>` against the thrown message; use a stable
substring such as `must be a set` or `duplicate rows`).

- **Bag body fails at create with the new message.**
  ```sql
  create table orders (id integer primary key, status text);
  insert into orders values (1,'open'),(2,'open'),(3,'shipped');
  create materialized view mv_status as select status from orders;
  -- error: must be a set
  ```
  Also assert the message does **not** mention the backing table name (no
  `sqlite_mv_` / `PK.`), to lock in the user-facing contract. The MV must not be
  left half-registered (backing table rolled back) — a follow-up
  `create materialized view mv_status as select distinct status from orders;`
  must succeed, proving the name is free.

- **Distinct/keyed bodies still work** (regression guard alongside the existing
  `select y from pt` all-columns case at line 89):
  ```sql
  create materialized view mv_status as select distinct status from orders;
  select * from mv_status order by status;
  → [{"status":"open"},{"status":"shipped"}]
  ```

- **Late duplicate at refresh.** Create a body that is duplicate-free, then make
  the source produce a duplicate and `refresh` — expect the same diagnostic at
  refresh time (not create), confirming the documented late-failure mode:
  ```sql
  create table u (id integer primary key, k text);
  insert into u values (1,'a'),(2,'b');
  create materialized view mv_u as select k from u;   -- distinct → ok
  update u set k='a' where id=2;                       -- now two 'a' rows
  refresh materialized view mv_u;
  -- error: must be a set
  ```

Run: `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/mv-bag.log; tail -n 60 /tmp/mv-bag.log`
(or the repo-root `yarn test`). Also run `yarn workspace @quereus/quereus run build`
and the lint script before handoff.

## Docs

Update `docs/materialized-views.md`:
- §"Primary key inference (and the all-columns fallback)" (lines ~59-72): replace
  the "fails loudly with `UNIQUE constraint failed`" paragraph with the resolved
  contract — an MV must be a set; a duplicate-producing body raises the
  purpose-built "must be a set" diagnostic at create (or at the next refresh if
  the body only later becomes duplicate-producing). Keep the note that a
  duplicate-free keyless body still materializes on the all-columns key.
- The incremental note (lines ~257-259) and the "Bag-body contract" forward
  reference (lines ~456-457): update from "tracked separately" to describe the
  shipped contract (drop the `materialized-view-bag-body-duplicates` TODO
  pointer).
- Update the `replaceBaseLayer` parenthetical at line ~117 ("guards duplicate
  PKs") only if wording needs to reflect the caller-supplied diagnostic.

## TODO

- [ ] Add optional `onDuplicateKey?: () => QuereusError` param to
      `MemoryTableManager.replaceBaseLayer`; use it in the duplicate branch,
      falling back to the existing generic message when absent. Update the
      method's JSDoc. Do **not** change `insertRow` (non-MV path).
- [ ] Add `materializedViewNotASetError(schemaName, viewName)` to
      `materialized-view-helpers.ts`.
- [ ] Wire the factory through `rebuildBacking` (uses `mv.schemaName`/`mv.name`)
      and the create path in `materialized-view.ts` (uses
      `plan.schemaName`/`plan.viewName`).
- [ ] Extend `51-materialized-views.sqllogic` with the three cases above.
- [ ] Update `docs/materialized-views.md` as described.
- [ ] `yarn workspace @quereus/quereus run build`, `yarn test`, and lint green.
