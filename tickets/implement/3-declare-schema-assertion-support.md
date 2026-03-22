description: Add assertion support to DECLARE SCHEMA (parse, diff, DDL generation)
dependencies: none
files:
  packages/quereus/src/parser/ast.ts              # DeclaredAssertion type, DeclareItem union
  packages/quereus/src/parser/parser.ts            # declareSchemaStatement, new declareAssertionItem
  packages/quereus/src/emit/ast-stringify.ts       # createAssertionToString, declareItemToString
  packages/quereus/src/schema/schema-differ.ts     # computeSchemaDiff, generateMigrationDDL
  packages/quereus/src/schema/catalog.ts           # CatalogAssertion (already exists, read-only)
  packages/quereus/test/logic/50-declarative-schema.sqllogic  # integration tests
----

## Background

`CREATE ASSERTION` and `DROP ASSERTION` are fully implemented as standalone SQL statements.
Assertions are stored in `Schema`, collected by `collectSchemaCatalog`, and the `SchemaDiff`
interface already has `assertionsToCreate` / `assertionsToDrop` fields — but they are never
populated because `DECLARE SCHEMA` has no way to declare assertions.

## Changes

### 1. AST — `DeclaredAssertion` type (ast.ts ~line 565)

Add a new interface and extend the `DeclareItem` union:

```typescript
export interface DeclaredAssertion extends AstNode {
  type: 'declaredAssertion';
  assertionStmt: CreateAssertionStmt;
}

export type DeclareItem = DeclaredTable | DeclaredIndex | DeclaredView | DeclaredSeed | DeclaredAssertion | DeclareIgnoredItem;
```

### 2. Parser — ASSERTION keyword in DECLARE SCHEMA (parser.ts ~line 2597)

In `declareSchemaStatement()`, add a branch before the fallback:

```typescript
} else if (this.peekKeyword('ASSERTION')) {
  this.advance();
  items.push(this.declareAssertionItem());
}
```

Add a `declareAssertionItem()` method that reuses `createAssertionStatement()`:

```typescript
private declareAssertionItem(): AST.DeclaredAssertion {
  const startToken = this.previous();
  const assertionStmt = this.createAssertionStatement(startToken);
  return {
    type: 'declaredAssertion',
    assertionStmt,
    loc: assertionStmt.loc,
  };
}
```

Note: `createAssertionStatement` is already a private method at line 2344 that parses
`<name> CHECK ( <expr> )`. It just needs the start token (already consumed `ASSERTION` keyword,
so pass `this.previous()` — but verify that `createAssertionStatement` uses `startToken` only
for location tracking, which it does).

### 3. AST Stringify (ast-stringify.ts)

Add `createAssertionToString()` and export it:

```typescript
export function createAssertionToString(stmt: AST.CreateAssertionStmt): string {
  return `create assertion ${stmt.name} check (${expressionToString(stmt.check)})`;
}
```

Add a case in `astToString()` for `'createAssertion'`:

```typescript
case 'createAssertion':
  return createAssertionToString(node as AST.CreateAssertionStmt);
```

Add handling in `declareItemToString()`:

```typescript
if (it.type === 'declaredAssertion') {
  return `assertion ${it.assertionStmt.name} check (...)`;
}
```

### 4. Schema Differ — assertion diffing (schema-differ.ts)

In `computeSchemaDiff()`:

- Build a `declaredAssertions` map from `declaredSchema.items` (filter for `'declaredAssertion'`),
  keyed by lowercase assertion name.
- Build an `actualAssertions` map from `actualCatalog.assertions`, keyed by lowercase name.
- For each declared assertion not in actual: push `createAssertionToString(item.assertionStmt)` to `diff.assertionsToCreate`.
- For each actual assertion not in declared: push the name to `diff.assertionsToDrop`.

Import `createAssertionToString` from `ast-stringify.ts`.

### 5. Schema Differ — assertion DDL generation (schema-differ.ts)

In `generateMigrationDDL()`:

- Drop assertions (before table drops, since assertions may reference tables):
  ```typescript
  for (const name of diff.assertionsToDrop) {
    statements.push(`DROP ASSERTION IF EXISTS ${schemaPrefix}${name}`);
  }
  ```

- Create assertions (after table creates, since assertions reference tables):
  ```typescript
  statements.push(...diff.assertionsToCreate);
  ```

### 6. Tests (50-declarative-schema.sqllogic)

Append test cases covering:

- Declare schema with an assertion, diff shows `CREATE ASSERTION` DDL
- Apply creates the assertion, subsequent diff is empty
- Assertion is enforced (commit with violation fails)
- Redeclare schema without the assertion, diff shows `DROP ASSERTION`
- Apply removes the assertion, violation no longer fails
- Multiple assertions in one schema declaration

## TODO

- [ ] Add `DeclaredAssertion` interface to ast.ts, update `DeclareItem` union
- [ ] Add `ASSERTION` branch to parser's `declareSchemaStatement()` + `declareAssertionItem()` method
- [ ] Add `createAssertionToString()` to ast-stringify.ts; add `'createAssertion'` case to `astToString()`; update `declareItemToString()`
- [ ] Add assertion diffing logic to `computeSchemaDiff()`
- [ ] Add assertion DDL to `generateMigrationDDL()` (drops before table drops, creates after table creates)
- [ ] Add sqllogic test cases to 50-declarative-schema.sqllogic
- [ ] Verify build and tests pass
