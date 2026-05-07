description: Wire partial-WHERE into UNIQUE index enforcement, and reject CREATE UNIQUE INDEX over data that already contains duplicates. Also re-enable the post-hoc UNIQUE INDEX assertion (already passes).
prereq:
files:
  packages/quereus/src/parser/ast.ts (CreateIndexStmt.where — already parsed)
  packages/quereus/src/schema/table.ts (IndexSchema, UniqueConstraintSchema)
  packages/quereus/src/schema/manager.ts (buildIndexSchema, addIndexToTableSchema, createIndex)
  packages/quereus/src/vtab/memory/layer/manager.ts (createIndex, checkSingleUniqueConstraint, ensureUniqueConstraintIndexes)
  packages/quereus/src/vtab/memory/layer/base.ts (addIndexToBase, populateNewIndex)
  packages/quereus/src/vtab/memory/index.ts (MemoryIndex)
  packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic
  packages/quereus/test/logic/102.1-unique-edge-cases.sqllogic
----

## Problem & scope

Three closely-related defects share the `IndexSchema` / `UniqueConstraintSchema` data path and the index-build flow. Fixing them together avoids duplicated plumbing for the partial-predicate carriage:

1. **Partial UNIQUE WHERE ignored.** `create unique index ix on t(c) where p` enforces uniqueness across all rows. The AST's `CreateIndexStmt.where` is parsed but neither `buildIndexSchema` nor `addIndexToTableSchema` propagates the predicate (`packages/quereus/src/schema/manager.ts` ~lines 1023, 1062). The runtime `checkSingleUniqueConstraint` (`packages/quereus/src/vtab/memory/layer/manager.ts:728`) has no predicate to consult.

2. **`CREATE UNIQUE INDEX` over pre-existing duplicates is silently accepted.** `BaseLayer.populateNewIndex` (`packages/quereus/src/vtab/memory/layer/base.ts:224`) iterates the primary tree and `addEntry`s each row with no uniqueness check; `MemoryIndex.addEntry` (`packages/quereus/src/vtab/memory/index.ts:138`) merges duplicate keys into the same `primaryKeys` set without complaint. Result: index exists, with multiple PKs sharing a key, and a UNIQUE constraint that was never validated against existing data.

3. **(Likely-stale TODO) post-hoc CREATE UNIQUE INDEX enforcement.** Direct reproduction (`create table … (k integer primary key, x text not null); insert (1,'a'),(2,'b'); create unique index … on t(x); insert (3,'a')`) **does** raise `UNIQUE constraint failed: t (x)`. The TODO at `packages/quereus/test/logic/102.1-unique-edge-cases.sqllogic:73` appears stale — verify by uncommenting and only investigate further if it still reproduces.

## Expected behavior

- Partial UNIQUE: a row whose values do not satisfy the index predicate is **not** inserted into the index and is **not** considered for the uniqueness check (mirrors SQLite partial-index semantics; multiple NULLs are also still allowed independently of the predicate).
- `CREATE UNIQUE INDEX` over existing data must scan rows that satisfy the predicate (or all rows, for a non-partial index) and raise a `UNIQUE`-style constraint error if duplicates exist among the indexed key tuples. The index, the `uniqueConstraints` entry, and any schema mutations must be rolled back on failure.
- A successful post-hoc `CREATE UNIQUE INDEX` must reject subsequent INSERT/UPDATE that would violate it. (Validate via the re-enabled fixture; if my reproduction is wrong, fall back to investigating the live-schema lookup path.)

## Design

### IndexSchema / UniqueConstraintSchema carriage

Add a `predicate?: Expression` field to both `IndexSchema` and `UniqueConstraintSchema` (in `packages/quereus/src/schema/table.ts`). Store the parsed AST `Expression` directly (the same shape stored on `RowConstraintSchema.expr`, see `table.ts:307`).

In `SchemaManager.buildIndexSchema` and `addIndexToTableSchema` (`packages/quereus/src/schema/manager.ts:1023,1062`), copy `stmt.where` onto both the synthesized `IndexSchema` and the synthesized `UniqueConstraintSchema`. Same for `MemoryTableManager.createIndex` at `packages/quereus/src/vtab/memory/layer/manager.ts:1219`.

### Predicate evaluation against a Row

The constraint check operates on a `Row` (`SqlValue[]`) inside the memory layer. We need to evaluate an `Expression` against named columns. Two choices:

- **Compile once, evaluate many.** At index-creation time, lower the AST predicate into a closure `(row: Row) => boolean` using the existing column-index map. Cache it on the `MemoryIndex` and (for the constraint path) on the `UniqueConstraintSchema` lookup result. Reuse the planner's `analysis/const-evaluator.ts` machinery if it accepts a free-variable resolver; otherwise add a small dedicated evaluator that supports the predicate forms our parser produces (column refs, literals, `=` `<>` `<` `<=` `>` `>=`, `is null`, `is not null`, `and`, `or`, `not`). This is sufficient to cover the existing partial-index fixture (`10.5.1-partial-indexes.sqllogic`) and standard SQLite partial-index usage.

- **Reuse the row-aware expression evaluator** that already exists for CHECK constraints if one is reachable from the layer manager. Inspect `packages/quereus/src/planner/building/constraint-builder.ts` and the `constraint-check-node` runtime to see if the same compiled artifact can be reused (the CHECK path also needs a row → boolean evaluator).

Pick whichever is cleaner; document the choice in code only if non-obvious.

### Partial UNIQUE — runtime checks

In `MemoryTableManager.checkSingleUniqueConstraint` (`packages/quereus/src/vtab/memory/layer/manager.ts:728`):
- If the constraint has a predicate, evaluate it against `newRowData`. If it returns false (or null — SQL three-valued: a partial-index predicate that is not unambiguously TRUE excludes the row), skip the uniqueness check entirely.

In `MemoryTableManager.uniqueColumnsChanged` / UPDATE path (`manager.ts:626`): preserve correct semantics when a row transitions out of (or into) the partial scope. Easiest: always re-check on UPDATE if the constrained columns OR any column referenced by the predicate changed. Compute the predicate's referenced column set once at index creation.

### Partial UNIQUE — index population & maintenance

In `BaseLayer.populateNewIndex` (`base.ts:224`): if the new index has a predicate, evaluate it per row and skip rows that don't satisfy it.

In the per-row index update path (search for the call site that maintains secondary indexes on `recordUpsert`/`recordDelete` — likely in `transaction.ts` or `base.ts` near `addEntry`/`removeEntry`): on insert, only add when predicate(new) is true; on delete, only remove when predicate(old) was true; on update, manage transitions:
- predicate(old)=F, predicate(new)=F: nothing
- predicate(old)=F, predicate(new)=T: addEntry(new)
- predicate(old)=T, predicate(new)=F: removeEntry(old)
- predicate(old)=T, predicate(new)=T: removeEntry(old) + addEntry(new) (only if key changed)

This is also what makes the partial-index fixture's "transition out of scope frees the code" assertion (`10.5.1-partial-indexes.sqllogic:55`) work.

### Pre-existing-duplicate validation at CREATE UNIQUE INDEX

In `BaseLayer.populateNewIndex` (or a dedicated helper called from `addIndexToBase`): when `indexSchema.unique` is true, walk the primary tree, evaluate the predicate (if any), and detect duplicate index keys. On the first duplicate, throw `QuereusError(... StatusCode.CONSTRAINT, message: 'UNIQUE constraint failed: <table> (<cols>)')` so the caller's catch-and-rollback at `manager.ts:1274` puts the schema back. Multi-NULL is allowed (`uc.columns.some(NULL)` short-circuits — same rule as `checkSingleUniqueConstraint` in `manager.ts:737`).

This means `MemoryIndex.addEntry` does not need to throw; the validation is upstream and the index ends up either fully populated and consistent, or never persisted.

### Re-enable test fixtures

Uncomment in `packages/quereus/test/logic/102.1-unique-edge-cases.sqllogic`:
- lines 57–73 (CREATE UNIQUE INDEX over duplicates)
- lines 75–85 (post-hoc enforcement) — verify it passes; if it doesn't, investigate live-schema lookup and add follow-up findings to the ticket.

Uncomment in `packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic` lines 35–61.

### Out of scope

- Composite (ASC, DESC) ordering match — handled by the sibling ticket `2-fix-composite-asc-desc-index-ordering`.
- Partial indexes for non-memory vtabs (e.g. LevelDB store) — only the memory module is in scope here. If `quereus-store` already mirrors the memory module's index logic, sweep the same change there; otherwise track separately.

## Tests / validation

- All four uncommented blocks in the two `.sqllogic` files pass.
- Existing partial-index fixture sections (1, 3, 4, 5) continue to pass — no regression on the non-UNIQUE partial-index path.
- `yarn test` clean across the workspace.
- `yarn lint` clean for `packages/quereus`.

## TODO

Phase 1 — schema carriage
- Extend `IndexSchema` and `UniqueConstraintSchema` with `predicate?: Expression`.
- Pipe `stmt.where` through `SchemaManager.buildIndexSchema` and `addIndexToTableSchema`.
- Pipe predicate through `MemoryTableManager.createIndex` when synthesizing `updatedUniqueConstraints` (`packages/quereus/src/vtab/memory/layer/manager.ts:1242-1257`) and through `ensureUniqueConstraintIndexes` so the auto-created indexes preserve any constraint-level predicate (table-level UNIQUE constraints currently can't have one — verify and document).

Phase 2 — predicate evaluator
- Pick the evaluator strategy (reuse vs. small dedicated walker). Compile predicate to `(row: Row) => boolean | null` at index/constraint creation. Expose referenced-column set for the UPDATE path.

Phase 3 — runtime enforcement
- Skip `checkSingleUniqueConstraint` for new rows that don't satisfy predicate.
- Use predicate when populating a new index in `BaseLayer.populateNewIndex` and when maintaining the index on insert/update/delete.
- Update `uniqueColumnsChanged` (or its caller) to also trigger re-check when predicate-referenced columns change on UPDATE.

Phase 4 — duplicate-validation at CREATE UNIQUE INDEX
- In `addIndexToBase` (or `populateNewIndex`), when `indexSchema.unique`, detect duplicate keys among in-scope rows and throw a `CONSTRAINT` error with the standard `UNIQUE constraint failed: <table> (<cols>)` message before persisting the index.
- Confirm the `manager.ts:1274` catch rolls schema back to `originalManagerSchema`.

Phase 5 — tests + cleanup
- Uncomment the three TODO blocks in the two .sqllogic fixtures. Verify they pass.
- Remove the `-- TODO bug:` comments once green.
- If `102.1` lines 75-85 still fail (post-hoc enforcement), investigate further; otherwise note in commit message that it was already fixed and the test was just disabled.
- Run `yarn test` and `yarn lint`.
