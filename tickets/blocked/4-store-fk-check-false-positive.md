description: FK CHECK constraint (_fk_ref_child_parent_id) fires at COMMIT under the store module for valid references
dependencies: 4-store-transaction-isolation-and-rollback (still in tickets/fix/, not yet landed)
files:
  packages/quereus/src/runtime/deferred-constraint-queue.ts
  packages/quereus/src/core/database-transaction.ts
  packages/quereus-store/src/common/store-table.ts
  packages/quereus/test/logic/41-foreign-keys.sqllogic
----

## Blocked on: `4-store-transaction-isolation-and-rollback`

### Why blocked

Research confirms the failing scenario and root cause, but the fix cannot be meaningfully attempted until the dependency lands.

The failing block is `41-foreign-keys.sqllogic:195-221` — CASCADE UPDATE:

```sql
create table ref_parent (id integer primary key, value text);
create table ref_child (
    id integer primary key,
    parent_id integer,
    foreign key (parent_id) references ref_parent(id) on update cascade
);
insert into ref_parent values (1, 'A'), (2, 'B');
insert into ref_child values (100, 1), (101, 1), (200, 2);

update ref_parent set id = 10 where id = 1;   -- cascades parent_id 1→10 in ref_child
-- commit-time deferred FK check _fk_ref_child_parent_id fails under store
```

At auto-commit, `DeferredConstraintQueue.runDeferredRows` (`packages/quereus/src/runtime/deferred-constraint-queue.ts:66-89`) runs the enqueued FK evaluators. Each evaluator queries `ref_parent` via the normal read path for `id = 10` (the cascaded new value). Under the store module, the parent `UPDATE` is staged in a write buffer that the read path does not see — the evaluator finds no match and throws `CHECK constraint failed: _fk_ref_child_parent_id`.

This is the same visibility gap described in section A ("Reads inside a transaction don't see the transaction's own writes") of `4-store-transaction-isolation-and-rollback`. Memory mode passes because its VTab reads reflect pending writes.

### Tradeoff / open question

- **Option 1 (default expected):** Dependency fix (overlay that reads-through pending writes) resolves this automatically. After it lands, re-run `41-foreign-keys.sqllogic` under `QUEREUS_TEST_STORE=true`; if green, close this as resolved-by-dependency.
- **Option 2:** If the dependency lands with an overlay that the vtab read path uses generally, but the constraint evaluator still goes through a different cursor/scan path that bypasses the overlay, a secondary fix is needed in the deferred-constraint evaluation code path (ensure it reads via the connection/session that holds the overlay). No evidence yet that this is needed — but can't be ruled out without the dependency fix in place.

Unblock: once `4-store-transaction-isolation-and-rollback` is in `review/` or `complete/`, re-run `yarn test:store` on `41-foreign-keys.sqllogic`; either move this to `complete/` (resolved-by-dependency, with a confirming store spec added) or to `implement/` with a narrowed scope (evaluator read-path bypass of the overlay).

### TODO (deferred until dependency lands)

- Re-run `41-foreign-keys.sqllogic` under `QUEREUS_TEST_STORE=true`
- If still failing, capture the specific failing block and narrow to evaluator read-path
- Add a store-package spec under `packages/quereus-store/test/` covering parent+child insert then cascade update in a single transaction
