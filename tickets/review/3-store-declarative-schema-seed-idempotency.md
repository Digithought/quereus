description: LevelDB provider now physically deletes table data directories on DROP so re-creating a table with the same name starts empty; resolves `apply schema … with seed` UNIQUE-PK violation in store mode.
dependencies: none
files:
  packages/quereus-plugin-leveldb/src/provider.ts
  packages/quereus/test/logic/50-declarative-schema.sqllogic
----

## Root cause

`LevelDBProvider.deleteTableStores` and `deleteIndexStore` only closed the in-memory `LevelDBStore` handle; the on-disk directory (`basePath/<schema>/<table>/`) was left untouched. When a later `CREATE TABLE <same name>` called `getStore`, classic-level re-opened the directory and returned all previously-committed rows. The IndexedDB provider already calls `manager.deleteObjectStore`, so only the LevelDB backend was affected.

In `50-declarative-schema.sqllogic` the `users` table is seeded at step 7 (Alice, Bob), implicitly dropped at step 19 when the declared schema is replaced with categories/products, and re-created at step 28. Under LevelDB the re-created table inherited the step 7 rows, so the idempotent seed batch (`DELETE FROM users; INSERT …`) collided on PK=1 — DELETE buffers within the transaction and the subsequent INSERT's uniqueness check read the unchanged KV store.

## Fix

`packages/quereus-plugin-leveldb/src/provider.ts`:

- Track the resolved filesystem path per opened store in a `storePaths: Map<string, string>` parallel to `stores`, so `options.path` overrides are honoured on delete.
- `deleteIndexStore` and `deleteTableStores` now close the store, then `fs.promises.rm(path, { recursive: true, force: true })` the directory.
- `deleteTableStores` also sweeps `basePath/<schema>/` for any `<table>_idx_<name>` directories that were never opened in this session (catches the post-restart DROP case).

## Validation

- Reproducer: `node packages/quereus/test-runner.mjs --store --grep "50-declarative"` — previously failed at line 332 (`UNIQUE constraint failed: primary key`). Now progresses past the seed block; the next failure is at line 671 in the assertion-rollback scenario, which is already tracked by `tickets/implement/4-store-transaction-isolation-and-rollback.md` (scenario B).
- `yarn --cwd packages/quereus-plugin-leveldb test`: 12 passing (no regressions).
- `yarn --cwd packages/quereus test` (memory mode): 2443 passing, 2 pending — unchanged.

## Review notes

- The LevelDB provider is Node-only (depends on `classic-level`), so `fs.promises.rm` is safe here; no cross-platform abstraction needed.
- Stats entries in the unified `__stats__` store are not cleaned up on DROP. Out of scope for this ticket; worth a follow-up if the stats key count becomes user-visible.
- No changes needed in `StoreModule.destroy` — it already invokes `provider.deleteTableStores` first and the interface contract (delete all stores for the table) is what the LevelDB implementation now honours.
