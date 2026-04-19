description: Store module throws "Store module does not support in-place primary key alteration" for ALTER TABLE ALTER PRIMARY KEY
dependencies: none
files:
  packages/quereus-store/src/common/store-module.ts
  packages/quereus-store/src/common/store-table.ts
  packages/quereus/src/runtime/emit/alter-table.ts
  packages/quereus/src/schema/schema-differ.ts
  packages/quereus/test/logic/41.1-alter-pk.sqllogic
  packages/quereus/test/logic/50.1-declare-schema-pk.sqllogic
----

Reproduced by `41.1-alter-pk.sqllogic:11` and `50.1-declare-schema-pk.sqllogic:29` under `QUEREUS_TEST_STORE=true`:

```
Error: Store module does not support in-place primary key alteration
```

The `alter-table-primary-key` ticket (commit `28f0d5fa`) added ALTER PK to memory but explicitly stubbed the store path with a throw. The declarative-schema diff path (`apply schema`) ends up invoking the same stub when a PK change is detected, which is why `50.1-declare-schema-pk.sqllogic` fails at setup.

### Approach

PK change on a store-backed table requires re-keying every row: read all rows, recompute their primary keys, and rewrite under the new key (with the old-key rows deleted). Because store data lives in KV subdirectories, this is an O(n) migration that must be transactional. Look at how memory implements the re-key in `packages/quereus/src/vtab/memory/layer/manager.ts` for the reference semantic.

### TODO

- Define the store-side migration: open the primary store, iterate rows, write under new key, delete old; run within the active transaction so rollback undoes the migration
- Coordinate with any secondary/index stores that embed key prefixes
- Update `store-module.ts` / `store-table.ts` to remove the throw and implement the operation
- Re-run `41.1-alter-pk.sqllogic` and `50.1-declare-schema-pk.sqllogic` in store mode
- Add a dedicated spec in `packages/quereus-store/test/alter-table.spec.ts` (it covers ADD/DROP/RENAME today, not ALTER PK)
