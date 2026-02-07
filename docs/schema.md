# Schema Management

The schema subsystem manages database schemas, tables, views, functions, and indexes. It coordinates virtual table module lifecycle, resolves names across multi-schema search paths, and emits typed change events.

## Key Types

### SchemaManager

Central coordinator for all schema operations. Owns the schema collection, module registry, and change notifier. One instance per `Database`.

### Schema

A named logical grouping of tables, views, functions, and assertions. Every database has at least `main` and `temp` schemas; additional schemas can be attached.

### TableSchema

Describes a table's structure: columns, primary key definition, CHECK constraints, associated virtual table module, indexes, and mutation context definitions. All tables are virtual tables — `vtabModule` and `vtabModuleName` are always present.

### ColumnSchema

Defines a single column: name, logical type, nullability, primary key membership, default value expression, collation, and whether the column is generated. Columns default to NOT NULL (Third Manifesto) unless `pragma default_column_nullability = 'nullable'` is set.

### IndexSchema / IndexColumnSchema

Describes a secondary index by name and an ordered list of column references (by index into `TableSchema.columns`) with optional sort direction and collation.

### RowConstraintSchema

A CHECK constraint with an AST expression, an operation bitmask (insert/update/delete), and deferral settings.

## SchemaManager API

### Schema Navigation

| Method | Description |
|--------|-------------|
| `getSchema(name)` | Returns a `Schema` by name, or `undefined` |
| `getSchemaOrFail(name)` | Returns a `Schema` or throws `QuereusError` |
| `getMainSchema()` | Shorthand for the `main` schema |
| `getTempSchema()` | Shorthand for the `temp` schema |
| `getCurrentSchemaName()` | Name of the current default schema |
| `setCurrentSchema(name)` | Sets the default schema for unqualified names |
| `addSchema(name)` | Creates a new schema (e.g. for ATTACH). Throws if name conflicts |
| `removeSchema(name)` | Removes a schema (e.g. for DETACH). Cannot remove `main` or `temp` |

### Table Lookup

| Method | Description |
|--------|-------------|
| `findTable(tableName, dbName?, schemaPath?)` | Finds a table across schemas. If `dbName` is provided, searches that schema only. If `schemaPath` is provided, searches those schemas in order. Otherwise uses default search order: `main`, then `temp` |
| `getTable(schemaName, tableName)` | Retrieves a table from a specific schema |
| `getView(schemaName, viewName)` | Retrieves a view definition |
| `getSchemaItem(schemaName, itemName)` | Returns a table or view by name (views take priority on name conflict) |
| `findSchemasContainingTable(tableName)` | Returns all schema names containing the table — useful for error messages |
| `findFunction(funcName, nArg)` | Finds a function by name and argument count |

### DDL Operations

#### `createTable(stmt): Promise<TableSchema>`

Creates a new table from a parsed `CreateTableStmt` AST node:
1. Resolves the virtual table module (explicit `USING` or configured default)
2. Builds column schemas, primary key definition, and CHECK constraints
3. Validates determinism of DEFAULT expressions
4. Calls `module.create()` to initialize storage
5. Registers the table in the target schema
6. Emits `table_added` change event

Throws on duplicate name (unless `IF NOT EXISTS`), missing module, or module creation failure.

#### `createIndex(stmt): Promise<void>`

Creates a secondary index from a parsed `CreateIndexStmt`:
1. Validates the target table exists and its module supports `createIndex`
2. Builds `IndexSchema` from column references
3. Delegates to `module.createIndex()`
4. Appends the index to the table's schema
5. Emits `table_modified` change event

#### `dropTable(schemaName, tableName, ifExists?): boolean`

Drops a table:
1. Calls `module.destroy()` asynchronously if the module supports it
2. Removes the table from the schema
3. Emits `table_removed` change event

Returns `true` if the table was removed. With `ifExists`, returns `false` silently when not found.

#### `dropView(schemaName, viewName): boolean`

Removes a view definition from the schema.

#### `clearAll()`

Clears all tables, functions, and views from all schemas. Does not call module disconnect/destroy.

### Virtual Table Modules

| Method | Description |
|--------|-------------|
| `registerModule(name, module, auxData?)` | Registers a virtual table module by name. Replaces any existing module with the same name |
| `getModule(name)` | Retrieves a registered module and its auxData |
| `setDefaultVTabModuleName(name)` | Sets the module used when `USING` is omitted in `CREATE TABLE`. Defaults to `'memory'` |
| `getDefaultVTabModuleName()` | Returns the current default module name |
| `setDefaultVTabArgs(args)` | Sets default module arguments (key-value) |
| `getDefaultVTabModule()` | Returns `{ name, args }` for the default module |

### Catalog Import

#### `importCatalog(ddlStatements): Promise<{ tables: string[]; indexes: string[] }>`

Imports existing schema objects without creating new storage. Used when connecting to a backend that already contains data. For each DDL statement:
- `CREATE TABLE` calls `module.connect()` instead of `module.create()`
- `CREATE INDEX` registers the index metadata without calling `module.createIndex()`
- Schema change events are not emitted (these are existing objects)

## Schema Change Events

The `SchemaChangeNotifier` (accessed via `schemaManager.getChangeNotifier()`) provides a typed event system for observing schema mutations.

### Subscribing

```typescript
const notifier = db.schemaManager.getChangeNotifier();

const unsubscribe = notifier.addListener((event) => {
  switch (event.type) {
    case 'table_added':
      console.log(`New table: ${event.schemaName}.${event.objectName}`);
      console.log('Schema:', event.newObject); // TableSchema
      break;
    case 'table_removed':
      console.log(`Dropped: ${event.objectName}`);
      console.log('Was:', event.oldObject); // TableSchema
      break;
    case 'table_modified':
      console.log('Before:', event.oldObject);
      console.log('After:', event.newObject);
      break;
  }
});

// Later:
unsubscribe();
```

### Event Types

The `SchemaChangeEvent` discriminated union includes:

| Event Type | Payload | When |
|------------|---------|------|
| `table_added` | `newObject: TableSchema` | After `createTable` |
| `table_removed` | `oldObject: TableSchema` | After `dropTable` |
| `table_modified` | `oldObject`, `newObject: TableSchema` | After `createIndex` or table alteration |
| `function_added` | `newObject: FunctionSchema` | After function registration |
| `function_removed` | `oldObject: FunctionSchema` | After function removal |
| `function_modified` | `oldObject`, `newObject: FunctionSchema` | After function replacement |
| `module_added` | _(name only)_ | After module registration |
| `module_removed` | _(name only)_ | After module removal |
| `collation_added` | _(name only)_ | After collation registration |
| `collation_removed` | _(name only)_ | After collation removal |

All events carry `schemaName` and `objectName` fields.

Listener errors are caught and logged — a failing listener does not disrupt other listeners or the originating operation.

### Database-Level Events

The higher-level `db.onSchemaChange()` API aggregates schema events from all modules. Events from modules with native event support flow through the module's own emitter; for other modules, `SchemaManager` emits synthetic events automatically. See the [Usage Guide](usage.md) for the database-level event API.

## Error Handling

Schema operations throw `QuereusError` with these common status codes:

| Code | Scenario |
|------|----------|
| `StatusCode.ERROR` | Module not found, schema not found, invalid DDL, module create/connect failure |
| `StatusCode.CONSTRAINT` | Table or index already exists (without `IF NOT EXISTS`), multiple primary key definitions |
| `StatusCode.NOTFOUND` | Table not found during `dropTable` (without `ifExists`) |
| `StatusCode.INTERNAL` | Module did not return a `tableSchema` after create, unexpected removal failure |
| `StatusCode.MISUSE` | Invalid argument format (e.g. non-object JSON for default vtab args) |

Errors include source location (`line`, `column`) when available from the AST node. See [Error Handling](errors.md) for the full error model.

## Declarative Schema

The `declare schema` / `diff schema` / `apply schema` workflow provides order-independent, end-state schema declarations. The engine computes diffs against the current catalog (`computeSchemaDiff`) and generates migration DDL (`generateMigrationDDL`). Key diff types:

- `SchemaDiff` — tables/views/indexes to create, drop, or alter
- `TableAlterDiff` — columns to add or drop within an existing table

Destructive changes (drops) require explicit acknowledgement. See the [SQL Reference](sql.md#20-declarative-schema-optional-order-independent) for full syntax and examples.
