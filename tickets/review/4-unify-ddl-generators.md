description: Review the unified canonical DDL generator, its session-aware emission rules, and downstream consumer rewiring
dependencies: none
files:
  - packages/quereus/src/schema/ddl-generator.ts (new; canonical implementation)
  - packages/quereus/src/schema/catalog.ts (now imports from ddl-generator)
  - packages/quereus/src/index.ts (exports generateTableDDL, generateIndexDDL)
  - packages/quereus-store/src/common/index.ts (re-exports from @quereus/quereus)
  - packages/quereus-store/src/common/store-module.ts (imports from @quereus/quereus)
  - packages/quereus-store/src/common/ddl-generator.ts (deleted)
  - packages/quoomb-web/src/worker/quereus.worker.ts (private method deleted; uses canonical export)
  - packages/quereus-store/test/ddl-generator.spec.ts (updated expectations; new no-db regression test)
  - packages/quereus/test/schema/catalog.spec.ts (new full-feature roundtrip + nullability pragma roundtrip)
  - docs/schema.md (new "DDL Generation" subsection under Catalog)
  - packages/quereus/README.md (plugin helpers list: canonical generator)
----

## What shipped

One canonical `generateTableDDL(tableSchema, db?)` and `generateIndexDDL(indexSchema, tableSchema, db?)` pair lives in `packages/quereus/src/schema/ddl-generator.ts`, exported from `@quereus/quereus`. Two drift copies are gone: `packages/quereus-store/src/common/ddl-generator.ts` (deleted; re-exported from canonical) and the private `generateTableDDL` method in `packages/quoomb-web/src/worker/quereus.worker.ts` (deleted; call site now uses the canonical export with the session `db`).

### Emission semantics

Signature is `(schema, db?)`. The optional `Database` parameter supplies session context (never read from globals):

| Aspect | With `db` | Without `db` |
|---|---|---|
| Schema qualification | Elided if matches `db.schemaManager.getCurrentSchemaName()` | Always qualified (`"schema"."name"`) |
| Column nullability | Only emits annotation that differs from `default_column_nullability` | Always explicit (`NULL` or `NOT NULL`) — guarantees cross-session re-parse safety |
| `USING <module> (...)` | Elided if both module and args match `default_vtab_module` / `default_vtab_args` | Always emitted whenever `vtabModuleName` is set |

Feature superset (all three original copies): `TEMP`, schema qualification, inline single-column `PRIMARY KEY`, table-level `PRIMARY KEY (...)` (including singleton `PRIMARY KEY ()`), `DEFAULT <expr>` (via `expressionToString`), `USING <module>` with SQL-literal args (strings quoted, numbers bare — not JSON), and `WITH TAGS (...)` at table, column, and index levels with reserved-word-safe quoted keys.

Identifiers (table / column / schema / index names) are always double-quoted for consistency. Tag keys use the conditional `quoteIdentifier` so bare keys appear unquoted when safe.

## Use cases for testing, validation & usage

### Round-trip parity (the original bug class)

Previously a singleton-PK memory table persisted through `@quereus/store` (IndexedDB/LevelDB) could lose its `PRIMARY KEY ()` semantics because the store's private generator differed from the catalog's. Now all consumers share one function, so a round-trip

```
tableSchema → generateTableDDL(schema, db) → db.exec(ddl) → new tableSchema
```

preserves:
- singleton `PRIMARY KEY ()` (asserted in `catalog.spec.ts "preserves singleton semantics across roundtrip"`)
- composite PKs
- explicit `NOT NULL` / `NULL` under any session nullability default
- table-, column-, and index-level `WITH TAGS`
- `DEFAULT` expressions

### Nullability pragma handling

The generator reads `db.options.getStringOption('default_column_nullability')` when a `db` is present and emits only the differing annotation. Under the (default) `'not_null'` mode, a `NOT NULL` column emits no annotation, a nullable column emits `NULL`. Under `'nullable'`, the polarity flips. Without `db`, both are always explicit. Covered by `catalog.spec.ts "honors default_column_nullability for emission and survives a roundtrip"`.

### Persistence (no-db) safety

Callers that need to serialize DDL outside a live `Database` call the generator without the `db` argument and get fully-qualified, explicitly-annotated output that re-parses to the same schema under any session. `ddl-generator.spec.ts "without db context: always qualifies, annotates, and emits USING with custom args"` guards this path.

## Validation

- `yarn build` clean across the monorepo.
- `yarn test` — 2419 quereus + 167 store + all downstream suites passing.
- No new lint errors (the one pre-existing unused-import error in `stats/histogram-builder.ts` is unrelated).

## Notes for the reviewer

- Behavior deliberately changed for the no-`db` form: it now always emits nullability annotations and always qualifies the schema. Two store tests that implicitly relied on the prior "elide when default / elide when main" behavior (`generates simple table with single PK`, `generates simple index`) were updated; these changes are substrings only and preserve the spirit of the tests.
- The store package still re-exports `generateTableDDL` / `generateIndexDDL` from its public `index.ts` so external consumers keep working.
- `db` is threaded through `collectSchemaCatalog` into both generators so session context reaches the catalog DDL emission path; previously the catalog's private generator was context-free.
