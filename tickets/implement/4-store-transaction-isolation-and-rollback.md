description: Logic test harness in store mode bypasses the isolation layer — wrap StoreModule with IsolationModule so in-transaction reads see own writes and failed commits roll back
dependencies: none
files:
  packages/quereus/test/logic.spec.ts
  packages/quereus-store/src/common/isolated-store.ts
  packages/quereus-store/src/common/store-module.ts
  packages/quereus/src/core/database-transaction.ts
  packages/quereus/test/logic/04-transactions.sqllogic
  packages/quereus/test/logic/42-committed-snapshot.sqllogic
  packages/quereus/test/logic/95-assertions.sqllogic
  packages/quereus/test/logic/101-transaction-edge-cases.sqllogic
  packages/quereus/test/logic/43-transition-constraints.sqllogic
  packages/quereus/test/logic/10.1-ddl-lifecycle.sqllogic
  packages/quereus-store/test/isolated-store.spec.ts
----

## Root cause

`StoreModule` is intentionally non-isolating. Its own docstring (`packages/quereus-store/src/common/store-module.ts:99-113`) and `getCapabilities()` (`isolation: false`) say so explicitly: writes flush to the backing KV on xCommit without any per-transaction overlay. The isolation layer that provides read-your-own-writes, rollback, and savepoints already exists as `@quereus/isolation` and is wired up via the convenience helper `createIsolatedStoreModule` (`packages/quereus-store/src/common/isolated-store.ts`) — which is exported from `@quereus/store`.

The logic-test harness (`packages/quereus/test/logic.spec.ts:499-509`) registers bare `new StoreModule(provider)` and therefore exercises the non-isolating path. This is the only reason scenarios A and B fail under `QUEREUS_TEST_STORE=true`.

### Why scenario B is resolved by isolation alone

`TransactionManager.commitTransaction` (`packages/quereus/src/core/database-transaction.ts:160-211`) runs `runGlobalAssertions()` and `runDeferredRowConstraints()` **before** invoking `connection.commit()` on any vtab. On failure it calls `connection.rollback()` on every connection (line 196). With isolation in place, staged writes live in an overlay memory table and `rollback()` discards them without ever touching the KV store. No engine-side changes are needed.

## Fix

Change the store-mode branch of the logic-test `beforeEach` to use `createIsolatedStoreModule`:

```ts
// in loadStoreModules() — also pull in createIsolatedStoreModule
const storePlugin = await import('@quereus/store');
StoreModule = storePlugin.StoreModule;
createIsolatedStoreModule = storePlugin.createIsolatedStoreModule;

// in beforeEach, store branch
testStorePath = createStoreTestDir();
const provider = createLevelDBProvider({ basePath: testStorePath.replace(/\\/g, '/') });
leveldbModule = createIsolatedStoreModule({ provider });
db.registerModule('store', leveldbModule);
db.setOption('default_vtab_module', 'store');
```

`closeAll()` is defined on the underlying `StoreModule`, not on the `IsolationModule` wrapper — the afterEach teardown needs to either reach into the wrapper for its underlying, or skip `closeAll` and rely on the leveldb provider close path. Verify during implementation; `IsolationModule` likely exposes an `underlying` accessor or a pass-through `closeAll`.

## Follow-on cleanups

- Remove `04-transactions.sqllogic` from `MEMORY_ONLY_FILES` — its reason ("store module buffers writes until commit") is no longer true under isolation. Run the file in store mode; if it passes, drop it from the set. If a subset still fails for reasons unrelated to read-your-own-writes, narrow the exclusion with a comment rather than restoring the blanket skip.

- Sanity-check savepoint coverage. `101-transaction-edge-cases.sqllogic:109` exercises nested savepoints; the isolation layer handles these via nested overlay transactions per the design doc (`docs/design-isolation-layer.md`). Confirm it passes rather than assuming.

## Explicit regression tests

Add to `packages/quereus-store/test/isolated-store.spec.ts`:

- **scenario A, read-your-own-writes after UPDATE**: exists in spirit for INSERT (line 199); add an UPDATE variant mirroring `42-committed-snapshot.sqllogic`.

- **scenario B, failed-commit rollback**: create a table with a deferred CHECK or an ASSERTION, BEGIN, do an update that violates it, `COMMIT` (expect throw), then SELECT and assert the row retains its pre-transaction value. This guards the whole path: deferred-constraint rejection → `connection.rollback()` → overlay discard → underlying KV unchanged.

## TODO

- Update `packages/quereus/test/logic.spec.ts` to use `createIsolatedStoreModule`
- Fix teardown path (`leveldbModule.closeAll()`) for the wrapper
- Remove `04-transactions.sqllogic` from `MEMORY_ONLY_FILES` if it now passes; otherwise narrow the skip
- Add UPDATE-based read-your-own-writes test and failed-commit-rollback test to `packages/quereus-store/test/isolated-store.spec.ts`
- `yarn test:store` — confirm 04, 10.1, 42, 43, 95, 101 all green
- `yarn test` — confirm memory-mode suite still green
