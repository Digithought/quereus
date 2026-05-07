description: UNIQUE index enforcement gaps — partial WHERE predicate ignored, post-hoc CREATE UNIQUE INDEX doesn't validate or enforce, composite (ASC,DESC) index not consumed for matching ORDER BY.
prereq:
files:
  packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic
  packages/quereus/test/logic/102.1-unique-edge-cases.sqllogic
  packages/quereus/test/optimizer/desc-index-ordering.spec.ts
  packages/quereus/src/schema/manager.ts
  packages/quereus/src/planner/rules/access/
----

## Problem

Several UNIQUE / index enforcement deficits cluster around `addIndexToTableSchema` and the index-consumption rules:

- **Partial UNIQUE index ignores the WHERE predicate.** `create unique index ... where status = 'active'` enforces uniqueness across all rows rather than only across the partial scope. The `WHERE` clause is parsed but the synthesized `UniqueConstraintSchema` carries no predicate (`packages/quereus/src/schema/manager.ts` ~lines 1052 + 1062).
- **`CREATE UNIQUE INDEX` on data with pre-existing duplicates is silently accepted.** No scan of existing rows is performed at index-build time.
- **Post-hoc `CREATE UNIQUE INDEX`** on already-unique data does not subsequently reject inserts that violate the new constraint — the new uniqueness rule isn't wired into the runtime constraint checks.
- **Composite (ASC, DESC) index not consumed** for `equality on the leading key + ORDER BY DESC on the trailing key`; an explicit SORT is still emitted instead of a forward range scan over the matching prefix.

## Expected behavior

- A partial UNIQUE index `unique idx on t(c) where p` enforces uniqueness only among rows where `p` is true; rows outside the partial scope may share `c` values freely (matches SQLite partial index semantics).
- `CREATE UNIQUE INDEX` must fail with a UNIQUE-violation error when the existing data contains duplicates of the indexed key tuple.
- Once a UNIQUE INDEX is successfully created, subsequent `INSERT` / `UPDATE` operations must enforce the new uniqueness constraint and reject violations.
- A composite index ordered `(a ASC, b DESC)` should satisfy `WHERE a = ? ORDER BY b DESC` without an explicit SORT — the equality on the leading key plus the trailing-key ordering matches the physical key order.

## Reproduction

Uncomment to reproduce; each block is currently commented `-- TODO bug:` or `it.skip`'d:

- `packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic:32` — partial UNIQUE index ignores WHERE, second insert with same code rejected even though `status = 'inactive'` is outside the partial scope.
- `packages/quereus/test/logic/102.1-unique-edge-cases.sqllogic:54` — CREATE UNIQUE INDEX over `('dup','dup')` data is accepted instead of erroring.
- `packages/quereus/test/logic/102.1-unique-edge-cases.sqllogic:73` — after a successful post-hoc CREATE UNIQUE INDEX on unique data, a later duplicate insert is not rejected.
- `packages/quereus/test/optimizer/desc-index-ordering.spec.ts:55` (`it.skip`) — `query_plan` still contains a `SORT` op for `WHERE category = 'a' ORDER BY score DESC` against `index ix_m on m(category ASC, score DESC)`.

## Likely investigation areas

- `packages/quereus/src/schema/manager.ts` — `addIndexToTableSchema` (~lines 1052, 1062) where `UniqueConstraintSchema` is synthesized; the index `where`-predicate AST needs to flow through into the constraint schema and into INSERT/UPDATE constraint emission.
- The `CREATE INDEX` builder path — needs a post-build validation scan of existing rows for UNIQUE indexes.
- The constraint-check emit path (insert/update) — must read the partial predicate and skip the uniqueness check for rows outside the scope; must also pick up indexes added after table creation.
- `packages/quereus/src/planner/rules/access/` (and ordering analysis under `packages/quereus/src/planner/rules/`) — composite index ordering match must consider per-column direction, not just key prefix.
