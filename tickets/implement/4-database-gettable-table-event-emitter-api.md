---
description: Public Database.getTable() returning a Table handle that exposes per-table event subscription
files:
  - packages/quereus/src/core/database.ts
  - packages/quereus/src/core/table-handle.ts        # NEW
  - packages/quereus/src/vtab/table.ts
  - packages/quereus/src/vtab/events.ts
  - packages/quereus/src/index.ts
  - packages/quereus/test/vtab-events.spec.ts
  - docs/usage.md
---

## Goal

Expose a public, narrow `Table` handle on `Database` so consumers can write:

```ts
const table = db.getTable('main', 'users');
const tableEmitter = table?.getEventEmitter();
const unsubscribe = tableEmitter?.onDataChange?.((event) => { ... });
```

…and un-skip the `describe.skip('getEventEmitter API', …)` block at
`packages/quereus/test/vtab-events.spec.ts:310`.

## Design

### Why a new public class instead of returning `VirtualTable`?

`VirtualTable` instances are **not persistent** — `module.create()` runs once at
CREATE TABLE time and the instance is discarded after `tableSchema` is captured
(`packages/quereus/src/schema/manager.ts:1496-1509`). Subsequent queries call
`module.connect()` to produce **ephemeral** `VirtualTable` instances per execution
(see `packages/quereus/src/runtime/utils.ts:120-170` / `runtime/emit/scan.ts:69-86`).
So there is no stable `VirtualTable` to hand out.

Returning the vtab `VirtualTable` type publicly would also leak `query()`,
`update()`, `executePlan()`, `createConnection()`, savepoint internals, etc. —
none of which user code should call directly.

**Decision:** introduce a narrow public class `TableHandle` (exported as `Table`)
in `packages/quereus/src/core/table-handle.ts`. It holds `(db, tableSchema, module)`
and exposes only the bits a consumer cares about.

### `Table` handle surface

```ts
export class Table {
    readonly schemaName: string;
    readonly tableName: string;
    /** Frozen reference to the underlying schema for read-only inspection. */
    readonly schema: TableSchema;
    /** Module name that owns this table (e.g. 'memory', 'memory_events'). */
    readonly moduleName: string;

    /**
     * Returns the table's event emitter.
     *
     * Currently this is the **module-level** `VTableEventEmitter` (the same
     * instance shared by all tables under that module). Consumers must filter
     * by `schemaName`/`tableName` on incoming events if they only care about
     * this one table. Returns `undefined` when the module does not provide an
     * emitter — in that case, fall back to `Database.onDataChange()` /
     * `Database.onSchemaChange()` (which the engine populates automatically
     * for modules without native event support).
     *
     * The handle is a snapshot taken at `db.getTable()` time. If the table is
     * dropped or replaced, the emitter reference remains valid (the module
     * outlives individual tables) but no further events for this table will
     * be produced. Callers should treat `getTable()` as the boundary of
     * validity and re-acquire after schema changes if they need fresh state.
     */
    getEventEmitter(): VTableEventEmitter | undefined;
}
```

Notes:

- No constructor is exposed publicly; instances come solely from
  `db.getTable()`.
- Returning the module-level emitter (rather than a per-table filter wrapper)
  matches the failing-spec expectation `assert.equal(tableEmitter, emitter)`
  and stays consistent with the existing `VirtualTable.getEventEmitter?()`
  shape (which already delegates to the module emitter in `MemoryTable`).
- Per-table filtered subscriptions are listed as future work (see Out of
  scope).

### `Database.getTable()`

```ts
/**
 * Returns a public handle to a table for inspection and per-table event
 * subscription. Returns `undefined` if the table does not exist.
 *
 * @param schemaName The schema name ('main', 'temp', or an attached schema).
 *                   Pass `undefined` to use the current default schema.
 * @param tableName  The table name (case-insensitive).
 */
getTable(schemaName: string | undefined, tableName: string): Table | undefined;
```

Implementation (in `packages/quereus/src/core/database.ts`):

```ts
getTable(schemaName: string | undefined, tableName: string): Table | undefined {
    this.checkOpen();
    const tableSchema = this.schemaManager.getTable(schemaName, tableName);
    if (!tableSchema) return undefined;
    const moduleName = tableSchema.vtabModuleName;
    if (!moduleName) return undefined;
    const moduleInfo = this.schemaManager.getModule(moduleName);
    if (!moduleInfo) return undefined;
    return new Table(this, tableSchema, moduleName, moduleInfo.module);
}
```

`Table.getEventEmitter()` reuses the existing helper
`tryGetEventEmitter(module)` from `database.ts:77-85` (lift it to a shared
location — `vtab/events.ts` is the natural home, beside `VTableEventEmitter`).
This is the same predicate used by `hookModuleEvents` so the two paths stay in
lock-step.

### Lifecycle contract (documented in JSDoc + `docs/usage.md`)

- `getTable()` returns `undefined` for unknown tables. No throw.
- The returned handle is a **snapshot**: schema is captured at call time. If
  the table is dropped or recreated, the handle keeps its frozen schema, but
  events stop arriving (no module operations target the gone table). Callers
  who watch schema changes should re-acquire on schema events.
- After `db.close()`, the handle's `getEventEmitter()` continues to return the
  same module emitter reference, but the module emitter itself will have been
  unhooked from the database during close — local subscriptions still receive
  events the module emits, but the database-level aggregator no longer fires.

### Module-level shared emitter — surprise mitigation

Because the module-level emitter is shared across all tables in that module,
`tableEmitter.onDataChange(cb)` will fire `cb` for **every** table in the
module, not just the one. The current spec covers the simple
single-table case where this distinction is invisible.

Mitigation in JSDoc above: explicit note that consumers must filter by
`schemaName`/`tableName` if they only care about one table. Filtering wrappers
are deferred to a future ticket (`backlog/`).

## Tests

Un-skip `describe.skip('getEventEmitter API', …)` at
`packages/quereus/test/vtab-events.spec.ts:310-338` (change `describe.skip` →
`describe`). The two existing tests should pass as-is once
`db.getTable()` + `Table.getEventEmitter()` are wired.

Add three new tests in the same block:

1. **Unknown table returns undefined**
   ```ts
   it('returns undefined for unknown tables', () => {
       assert.equal(db.getTable('main', 'no_such_table'), undefined);
       assert.equal(db.getTable('main', 'NoSuchTable'), undefined);
   });
   ```

2. **Unsubscribing detaches cleanly**
   ```ts
   it('unsubscribe stops further events', async () => {
       await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
       const handle = db.getTable('main', 'users');
       const seen: VTableDataChangeEvent[] = [];
       const off = handle!.getEventEmitter()!.onDataChange!((e) => seen.push(e));
       await db.exec("INSERT INTO users VALUES (1, 'Alice')");
       off();
       await db.exec("INSERT INTO users VALUES (2, 'Bob')");
       assert.equal(seen.length, 1);
   });
   ```

3. **Post-DROP handle still resolves emitter but receives no further events**
   ```ts
   it('post-DROP: handle keeps emitter, no events fire after table is gone', async () => {
       await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
       const handle = db.getTable('main', 'users')!;
       const seen: VTableDataChangeEvent[] = [];
       handle.getEventEmitter()!.onDataChange!((e) => {
           if (e.tableName === 'users') seen.push(e);
       });
       await db.exec("INSERT INTO users VALUES (1, 'Alice')");
       assert.equal(seen.length, 1);
       await db.exec('DROP TABLE users');
       // Handle should now resolve undefined from db.getTable, but the
       // previously-captured handle's emitter still works (no throw)
       assert.equal(db.getTable('main', 'users'), undefined);
       assert.notEqual(handle.getEventEmitter(), undefined);
       // Re-creating with the same name should not deliver events into the
       // stale subscription's filter for this run (no more inserts here).
   });
   ```

   *Note:* the third test verifies the documented contract — the handle is a
   snapshot and the emitter reference outlives the table, but no further
   events for the dropped name arrive (because no DML targets a dropped table
   until it is recreated, and even then it may bind to a fresh schema).

## Out of scope (file as `backlog/` if/when needed)

- **Per-table filtered subscription**: wrap module-level emitter so callbacks
  only fire for the specific `schemaName.tableName`. Useful but adds API
  surface and per-call closure cost; defer until a user asks.
- **Pattern-based or cross-table subscriptions** (already listed in the plan
  ticket).
- **Returning the live `VirtualTable` instance** publicly. Would require the
  engine to maintain a persistent connected vtab handle keyed by table — a
  much larger lifecycle change.
- **Schema-change-aware handle invalidation** (handle exposes an `isValid`
  flag / `disposed` event). The snapshot contract is simpler and sufficient
  for the immediate use cases.

## TODO

Implementation phases:

- Add `core/table-handle.ts` exporting the `Table` class with `db`,
  `tableSchema`, `moduleName`, `module` fields and `getEventEmitter()`
  delegating through the shared `tryGetEventEmitter` helper.
- Move `tryGetEventEmitter` from `core/database.ts:77-85` into
  `vtab/events.ts` (export it). Update `database.ts` import.
- Add `Database.getTable(schemaName, tableName): Table | undefined` near the
  existing `_findTable` / event-emitter methods in
  `packages/quereus/src/core/database.ts`. JSDoc covering lifecycle.
- Export `Table` from `packages/quereus/src/index.ts` (type + class).
- Change `describe.skip` → `describe` at
  `packages/quereus/test/vtab-events.spec.ts:310`.
- Add the three new tests (unknown table, unsubscribe, post-DROP) inside that
  block.
- Update `docs/usage.md` reactivity section (search for `db.onDataChange` near
  line 263) with a short subsection on `db.getTable(...)?.getEventEmitter()`
  for per-table subscriptions, calling out the module-shared-emitter caveat.
- Run `yarn workspace @quereus/quereus run test` and ensure the vtab-events
  spec passes (the un-skipped block and the three new tests).
- Run `yarn workspace @quereus/quereus run lint` and resolve any new lints
  introduced.
