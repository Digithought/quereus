description: Systematic review of schema management (catalog, tables, views, functions)
dependencies: none
files:
  packages/quereus/src/schema/assertion.ts
  packages/quereus/src/schema/catalog.ts
  packages/quereus/src/schema/change-events.ts
  packages/quereus/src/schema/column.ts
  packages/quereus/src/schema/declared-schema-manager.ts
  packages/quereus/src/schema/function.ts
  packages/quereus/src/schema/manager.ts
  packages/quereus/src/schema/schema.ts
  packages/quereus/src/schema/schema-differ.ts
  packages/quereus/src/schema/schema-hasher.ts
  packages/quereus/src/schema/table.ts
  packages/quereus/src/schema/view.ts
  packages/quereus/src/schema/window-function.ts
----
Review schema management: catalog, schema objects (tables, views, functions, assertions), schema diffing, hashing, and change events.

Key areas of concern:
- Catalog lookup correctness (case sensitivity, schema qualification)
- Schema diffing accuracy and completeness
- Hash stability (changes in hash = migration triggers)
- Change event emission (missing events, ordering)
- Declared schema manager lifecycle
- Column metadata correctness

Follow the review protocol in docs/review.md.
Trivial fixes may be applied directly; non-trivial findings become fix/ or plan/ tickets.
