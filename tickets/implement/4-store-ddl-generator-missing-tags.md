description: Add WITH TAGS emission to quereus-store DDL generator for table, column, and index tags
dependencies: 3-metadata-tags (complete)
files:
  - packages/quereus-store/src/common/ddl-generator.ts
  - packages/quereus-store/test/ddl-generator.spec.ts
  - packages/quereus/src/schema/catalog.ts (reference for formatTagValue/formatTagsClause pattern)
---

# Store DDL Generator — Emit WITH TAGS

## Bug

The store's `generateTableDDL()` and `generateIndexDDL()` in `packages/quereus-store/src/common/ddl-generator.ts` do not emit `WITH TAGS` clauses. Tags are silently dropped on persist/restore round-trips because:

- **Save path**: `StoreTable.initializeStore()` → `saveTableDDL()` → `generateTableDDL()` → DDL string → `__catalog__` KV store
- **Restore path**: DDL string → parser → `buildTableSchemaFromAST()` → `TableSchema` (this side works fine)

## Reproducing Tests (already written)

Three failing tests exist in `packages/quereus-store/test/ddl-generator.spec.ts`:

1. **"emits table-level WITH TAGS"** — `TableSchema.tags` with `display_name` and `audit` keys
2. **"emits column-level WITH TAGS"** — `ColumnSchema.tags` with `display_name` and `searchable` keys
3. **"emits index-level WITH TAGS"** — `IndexSchema.tags` with `label` and `priority` keys
4. **"does not emit WITH TAGS when tags are empty"** — verifies no spurious output

Run: `node --import ./packages/quereus-store/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus-store/test/ddl-generator.spec.ts" --reporter min --colors`

## Fix

### 1. Add `formatTagValue()` and `formatTagsClause()` helpers to `ddl-generator.ts`

Pattern from `catalog.ts:212-225`. The store already has `formatArgValue()` which is similar but lacks boolean TRUE/FALSE handling needed for tags. Add two small functions:

```typescript
function formatTagValue(value: SqlValue): string {
    if (value === null) return 'NULL';
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (typeof value === 'number' || typeof value === 'bigint') return String(value);
    if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
    return String(value);
}

function formatTagsClause(tags: Readonly<Record<string, SqlValue>>): string {
    const entries = Object.entries(tags)
        .map(([key, value]) => `"${key}" = ${formatTagValue(value)}`)
        .join(', ');
    return `WITH TAGS (${entries})`;
}
```

Import `SqlValue` from `@quereus/quereus` (already a dependency).

### 2. Emit table-level tags in `generateTableDDL()` (after USING clause, line ~67)

```typescript
if (tableSchema.tags && Object.keys(tableSchema.tags).length > 0) {
    parts.push(formatTagsClause(tableSchema.tags));
}
```

### 3. Emit column-level tags in the column loop (after default value, line ~43)

```typescript
if (col.tags && Object.keys(col.tags).length > 0) {
    colDef += ' ' + formatTagsClause(col.tags);
}
```

### 4. Emit index-level tags in `generateIndexDDL()` (after columns, line ~102)

```typescript
if (indexSchema.tags && Object.keys(indexSchema.tags).length > 0) {
    parts.push(formatTagsClause(indexSchema.tags));
}
```

## Scope Note

The store DDL generator also does not emit CHECK constraints, FOREIGN KEY constraints, or UNIQUE constraints (beyond PK). Therefore constraint-level tags cannot be emitted until the constraints themselves are. That is a separate parity issue — this ticket covers only the three tag emission points above where the underlying schema element IS already emitted.

## TODO

- Add `formatTagValue()` and `formatTagsClause()` helpers to `ddl-generator.ts`
- Add `SqlValue` type import
- Emit table-level `WITH TAGS` in `generateTableDDL()`
- Emit column-level `WITH TAGS` in the column definition loop
- Emit index-level `WITH TAGS` in `generateIndexDDL()`
- Verify all 3 new tests pass plus the existing 11
- Run `yarn build` to confirm no type errors
