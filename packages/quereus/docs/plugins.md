# Quereus Plugin System (package.json–centric)

Quereus plugins are standard ESM packages that declare their capabilities in `package.json` and expose a single runtime entry. At runtime, the module provides registrations for:

- **Virtual Tables** — Custom data sources that appear as SQL tables
- **Functions** — Custom SQL functions (scalar, aggregate, table-valued)
- **Collations** — Custom text sorting and comparison behaviors

This document standardizes how plugins are published, discovered, and loaded using `package.json`. There is no legacy mode to support.

## Authoring a plugin

### package.json requirements

- Use ESM: set `"type": "module"`.
- Add `keywords: ["quereus-plugin"]` for discovery.
- Expose a dedicated plugin entry using the `exports` subpath `./plugin`:

```json
{
  "name": "@acme/quereus-plugin-foo",
  "type": "module",
  "version": "1.2.3",
  "description": "Foo sources as virtual tables + helpers",
  "author": "Acme Inc.",
  "keywords": ["quereus-plugin"],
  "exports": {
    "./plugin": {
      "types": "./dist/plugin.d.ts",
      "browser": "./dist/plugin.browser.js",
      "default": "./dist/plugin.js"
    }
  },
  "peerDependencies": {
    "@quereus/quereus": "^0.24.0"
  },
  "engines": {
    "quereus": "^0.24.0"
  },
  "quereus": {
    "provides": {
      "vtables": ["foo_items"],
      "functions": ["foo_hash"],
      "collations": ["FOO_NATURAL"]
    },
    "settings": [
      { "key": "api_key", "label": "API Key", "type": "string" },
      { "key": "timeout", "label": "Timeout (ms)", "type": "number", "default": 5000 },
      { "key": "debug", "label": "Debug", "type": "boolean", "default": false }
    ]
  }
}
```

Notes:
- Root fields like `name`, `version`, `description`, `author` are canonical — do not duplicate them under `quereus`.
- Place plugin‑specific metadata under the top‑level `quereus` object:
  - `quereus.provides` — capabilities for display and review
  - `quereus.settings` — configuration schema for UIs/hosts
- Version gating should be declared at the root via `engines.quereus` or `peerDependencies['@quereus/quereus']`. Hosts should error if the declared range is incompatible.

### Runtime module contract

The export at `exports['./plugin']` must be an ES module that:

1) Exports a `manifest` object mirroring display metadata required by the host UI (it can be generated at build time from `package.json`).
2) Exports a default `register(db, config)` function that returns what to register.

```typescript
// ./dist/plugin.js
import type { Database, SqlValue } from '@quereus/quereus';

export const manifest = {
  name: 'Acme Foo',
  version: '1.2.3',
  description: 'Foo sources as virtual tables + helpers',
  provides: {
    vtables: ['foo_items'],
    functions: ['foo_hash'],
    collations: ['FOO_NATURAL']
  },
  settings: [
    { key: 'api_key', label: 'API Key', type: 'string' },
    { key: 'timeout', label: 'Timeout (ms)', type: 'number', default: 5000 }
  ]
};

export default function register(
  db: Database,
  config: Record<string, SqlValue> = {}
) {
  return {
    vtables: [/* vtable registrations */],
    functions: [/* function registrations */],
    collations: [/* collation registrations */]
  };
}
```

### Registration Function

The default export receives the database instance and user configuration and returns registrations. See examples below for virtual tables, functions, and collations.

## Virtual Table Plugins

Virtual tables allow you to expose external data sources as SQL tables. Use the exported TypeScript types for full type safety.

### Basic Virtual Table

```typescript
import {
  VirtualTable,
  VirtualTableModule,
  BaseModuleConfig,
  Database,
  TableSchema,
  Row,
  BestAccessPlanRequest,
  BestAccessPlanResult,
  AccessPlanBuilder
} from 'quereus';

// Configuration interface for your module
interface MyTableConfig extends BaseModuleConfig {
  initialData?: Row[];
}

// Virtual table implementation extending the base class
class MyTable extends VirtualTable {
  private data: Row[] = [];

  constructor(
    db: Database, 
    module: VirtualTableModule<any, any>, 
    schemaName: string, 
    tableName: string,
    config: MyTableConfig
  ) {
    super(db, module, schemaName, tableName);
    this.data = config.initialData || [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' }
    ];
  }

  // Modern query planning interface
  getBestAccessPlan(request: BestAccessPlanRequest): BestAccessPlanResult {
    // For simple tables, use full scan
    return AccessPlanBuilder.fullScan(this.data.length)
      .setHandledFilters(request.filters.map(() => false))
      .setExplanation('Simple table scan')
      .build();
  }

  // Query implementation using async iterator
  async* xQuery(): AsyncIterable<Row> {
    for (const row of this.data) {
      yield row;
    }
  }

  // Update operations (INSERT, UPDATE, DELETE)
  async xUpdate(operation: any, values: Row | undefined, oldKeyValues?: Row, onConflict?: ConflictResolution): Promise<Row | undefined> {
    if (operation === 'INSERT' && values) {
      this.data.push(values);
      return values;
    }
    // Handle UPDATE and DELETE as needed
    return undefined;
  }

  async xDisconnect(): Promise<void> {
    // Cleanup resources
  }
}

// Module implementation
class MyTableModule implements VirtualTableModule<MyTable, MyTableConfig> {
  xCreate(db: Database, tableSchema: TableSchema): MyTable {
    const config: MyTableConfig = {}; // Parse from tableSchema if needed
    return new MyTable(db, this, tableSchema.schemaName, tableSchema.tableName, config);
  }

  xConnect(
    db: Database,
    pAux: unknown,
    moduleName: string,
    schemaName: string,
    tableName: string,
    options: MyTableConfig
  ): MyTable {
    return new MyTable(db, this, schemaName, tableName, options);
  }

  getBestAccessPlan(
    db: Database,
    tableInfo: TableSchema,
    request: BestAccessPlanRequest
  ): BestAccessPlanResult {
    return AccessPlanBuilder.fullScan(100) // Estimated row count
      .setHandledFilters(request.filters.map(() => false))
      .build();
  }

  xBestIndex(): number { return 0; } // Legacy compatibility

  async xDestroy(): Promise<void> {
    // Cleanup persistent resources
  }
}

export default function register(db: Database, config: MyTableConfig) {
  return {
    vtables: [
      {
        name: 'my_table',
        module: new MyTableModule(),
        auxData: config
      }
    ]
  };
}
```

### Modern Query Planning

For advanced optimization, implement the modern planning interface:

```typescript
import {
  BestAccessPlanRequest,
  BestAccessPlanResult,
  AccessPlanBuilder,
  ConstraintOp,
  PredicateConstraint
} from 'quereus';

class AdvancedTable extends VirtualTable {
  getBestAccessPlan(request: BestAccessPlanRequest): BestAccessPlanResult {
    // Check for equality constraints on indexed columns
    const eqConstraints = request.filters.filter(f => 
      f.op === '=' && f.usable && this.isIndexedColumn(f.columnIndex)
    );

    if (eqConstraints.length > 0) {
      // Use index for equality lookups
      const handledFilters = request.filters.map(f => 
        eqConstraints.includes(f)
      );
      
      return AccessPlanBuilder.eqMatch(1) // Expect 1 row for unique lookup
        .setHandledFilters(handledFilters)
        .setOrdering(this.getIndexOrdering())
        .setIsSet(true) // Guarantees unique rows
        .setExplanation('Index equality seek on primary key')
        .build();
    }

    // Fall back to full scan
    return AccessPlanBuilder.fullScan(this.getEstimatedRowCount())
      .setHandledFilters(request.filters.map(() => false))
      .build();
  }

  private isIndexedColumn(columnIndex: number): boolean {
    // Check if column has an index
    return columnIndex === 0; // Example: first column is indexed
  }

  private getIndexOrdering() {
    return [{ columnIndex: 0, desc: false }];
  }
}
```

### Legacy Compatibility

For compatibility with older planning systems, also implement `xBestIndex`:

```typescript
xBestIndex(db: Database, tableInfo: TableSchema, indexInfo: IndexInfo): number {
  // Convert legacy IndexInfo to modern BestAccessPlanRequest
  const filters: PredicateConstraint[] = indexInfo.aConstraint.map(constraint => ({
    columnIndex: constraint.iColumn,
    op: this.mapConstraintOp(constraint.op),
    usable: constraint.usable
  }));

  const request: BestAccessPlanRequest = {
    columns: this.getColumnMetadata(),
    filters: filters
  };

  const result = this.getBestAccessPlan(request);
  
  // Map back to legacy IndexInfo format
  indexInfo.estimatedCost = result.cost;
  indexInfo.estimatedRows = BigInt(result.rows || 0);
  indexInfo.orderByConsumed = result.providesOrdering !== undefined;
  
  return StatusCode.OK;
}
```

### Usage

```sql
-- Create table using the plugin
CREATE TABLE users USING my_table();

-- Query the table
SELECT * FROM users WHERE id > 1;
```

## Catalog Introspection for Declarative Schema

Declarative schema diffing is performed in the engine. Modules continue to use the DDL‑oriented interface for creation and alteration. Optionally, a module can expose its current catalog so Quereus can compute precise diffs and produce canonical DDL.

Optional API:

```typescript
interface CatalogObject {
  kind: 'table' | 'index' | 'view' | 'domain' | 'collation';
  schemaName: string;
  name: string;
  ddl: string;                // Canonical DDL for this object
}

interface VirtualTableModule<...> {
  // Return module's catalog across all schemas or limited to one
  xGetCatalog?(db: Database, options?: { schema?: string }): Promise<ReadonlyArray<CatalogObject>> | ReadonlyArray<CatalogObject>;
}
```

Notes:
- Engine diff compares declared schema against the union of module catalogs and in‑engine state.
- `diff schema` outputs canonical DDL statements; users may run them or invoke `apply schema` to auto‑execute.
- `using ...` remains optional in declarations; default module selection is respected.

## Function Plugins

Functions extend SQL with custom computational logic.

### Scalar Functions

Return a single value:

```typescript
import { Database, FunctionFlags, SqlValue } from 'quereus';

function reverse(text: SqlValue): SqlValue {
  if (text === null || text === undefined) return null;
  return String(text).split('').reverse().join('');
}

export default function register(db: Database, config: any) {
  return {
    functions: [
      {
        schema: {
          name: 'reverse',
          numArgs: 1,
          flags: FunctionFlags.UTF8,
          returnType: { typeClass: 'scalar', sqlType: 'TEXT' },
          implementation: reverse
        }
      }
    ]
  };
}
```

### Table-Valued Functions

Return multiple rows:

```javascript
function* split_string(text, delimiter) {
  if (text === null || text === undefined) return;
  
  const parts = String(text).split(String(delimiter || ','));
  for (let i = 0; i < parts.length; i++) {
    yield { 
      index: i + 1, 
      value: parts[i].trim() 
    };
  }
}

export default function register(db, config) {
  return {
    functions: [
      {
        schema: {
          name: 'split_string',
          numArgs: 2,
          flags: 1,
          returnType: { 
            typeClass: 'relation',
            columns: [
              { name: 'index', type: 'INTEGER' },
              { name: 'value', type: 'TEXT' }
            ]
          },
          implementation: split_string
        }
      }
    ]
  };
}
```

### Aggregate Functions

Accumulate values across rows:

```javascript
function concatenateStep(accumulator, value) {
  if (value === null || value === undefined) return accumulator;
  return accumulator + String(value);
}

function concatenateFinal(accumulator) {
  return accumulator;
}

export default function register(db, config) {
  return {
    functions: [
      {
        schema: {
          name: 'str_concat',
          numArgs: 1,
          flags: 1,
          returnType: { typeClass: 'scalar', sqlType: 'TEXT' },
          stepFunction: concatenateStep,
          finalizeFunction: concatenateFinal,
          initialValue: ''
        }
      }
    ]
  };
}
```

### Variable Arguments

Use `numArgs: -1` for variadic functions:

```javascript
function myConcat(...args) {
  return args.filter(arg => arg !== null && arg !== undefined)
             .map(arg => String(arg))
             .join('');
}

// Registration with numArgs: -1
```

### Usage

```sql
-- Scalar function
SELECT reverse('hello') AS backwards;

-- Table-valued function
SELECT * FROM split_string('a,b,c', ',');

-- Aggregate function
SELECT str_concat(name) FROM users;
```

## Collation Plugins

Collations control text sorting and comparison behavior.

### Basic Collation

```typescript
import { Database, CollationFunction } from 'quereus';

const numericCollation: CollationFunction = (a: string, b: string): number => {
  // Parse out numeric parts for natural sorting
  const parseString = (str) => {
    const parts = [];
    let current = '';
    let inNumber = false;
    
    for (let i = 0; i < str.length; i++) {
      const char = str[i];
      const isDigit = char >= '0' && char <= '9';
      
      if (isDigit !== inNumber) {
        if (current) {
          parts.push(inNumber ? Number(current) : current);
          current = '';
        }
        inNumber = isDigit;
      }
      current += char;
    }
    
    if (current) {
      parts.push(inNumber ? Number(current) : current);
    }
    
    return parts;
  };
  
  const partsA = parseString(a);
  const partsB = parseString(b);
  
  const maxLen = Math.max(partsA.length, partsB.length);
  
  for (let i = 0; i < maxLen; i++) {
    const partA = partsA[i];
    const partB = partsB[i];
    
    if (partA === undefined) return -1;
    if (partB === undefined) return 1;
    
    if (typeof partA === 'number' && typeof partB === 'number') {
      if (partA !== partB) return partA < partB ? -1 : 1;
    } else {
      const strA = String(partA);
      const strB = String(partB);
      if (strA !== strB) return strA < strB ? -1 : 1;
    }
  }
  
  return 0;
}

export default function register(db, config) {
  return {
    collations: [
      {
        name: 'NUMERIC',
        func: numericCollation
      }
    ]
  };
}
```

### Usage

```sql
-- Use custom collation in ORDER BY
SELECT filename FROM files ORDER BY filename COLLATE NUMERIC;

-- Use in comparisons
SELECT * FROM files WHERE filename = 'file10.txt' COLLATE NUMERIC;
```

## Configuration

### Plugin Settings

Define configurable options in your manifest:

```javascript
export const manifest = {
  settings: [
    {
      key: 'api_key',
      label: 'API Key',
      type: 'string',
      help: 'Your API key for authentication'
    },
    {
      key: 'timeout',
      label: 'Timeout (ms)',
      type: 'number',
      default: 5000,
      help: 'Request timeout in milliseconds'
    },
    {
      key: 'enabled',
      label: 'Enable Feature',
      type: 'boolean',
      default: true
    },
    {
      key: 'mode',
      label: 'Operating Mode',
      type: 'select',
      options: ['fast', 'accurate', 'balanced'],
      default: 'balanced'
    }
  ]
};
```

### Using Configuration

```javascript
export default function register(db, config) {
  // Access configuration values
  const apiKey = config.api_key;
  const timeout = config.timeout || 5000;
  const enabled = config.enabled !== false;
  
  // Use in your plugin logic
  if (!enabled) {
    return { vtables: [], functions: [], collations: [] };
  }
  
  // ... rest of registration
}
```

## Complete Example

Here's a comprehensive plugin that demonstrates all three types:

```javascript
export const manifest = {
  name: 'Demo Plugin',
  version: '1.0.0',
  description: 'Demonstrates all plugin types',
  settings: [
    {
      key: 'debug',
      label: 'Debug Mode',
      type: 'boolean',
      default: false
    }
  ],
  provides: {
    vtables: ['key_value'],
    functions: ['upper_reverse'],
    collations: ['LENGTH']
  }
};

// Virtual table: simple key-value store
class KeyValueStore {
  constructor(args, config) {
    this.store = new Map();
  }

  getSchema() {
    return 'CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT)';
  }

  * scan() {
    for (const [key, value] of this.store) {
      yield { key, value };
    }
  }

  insert(row) {
    this.store.set(row.key, row.value);
  }

  delete(row) {
    this.store.delete(row.key);
  }
}

// Function: uppercase and reverse
function upperReverse(text) {
  if (text === null || text === undefined) return null;
  return String(text).toUpperCase().split('').reverse().join('');
}

// Collation: sort by length
function lengthCollation(a, b) {
  if (a.length !== b.length) {
    return a.length - b.length;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

export default function register(db, config) {
  if (config.debug) {
    console.log('Demo plugin loading...');
  }
  
  return {
    vtables: [
      {
        name: 'key_value',
        module: {
          create: async (tableName, args, config) => {
            const table = new KeyValueStore(args, config);
            return {
              schema: table.getSchema(),
              vtable: table
            };
          },
          connect: async (tableName, args, config) => {
            const table = new KeyValueStore(args, config);
            return {
              schema: table.getSchema(),
              vtable: table
            };
          }
        }
      }
    ],
    
    functions: [
      {
        schema: {
          name: 'upper_reverse',
          numArgs: 1,
          flags: 1,
          returnType: { typeClass: 'scalar', sqlType: 'TEXT' },
          implementation: upperReverse
        }
      }
    ],
    
    collations: [
      {
        name: 'LENGTH',
        func: lengthCollation
      }
    ]
  };
}
```

## TypeScript Benefits

With the exported types, plugin development gains several advantages:

### Full Type Safety

```typescript
// Compile-time checking of vtable implementations
class MyTable extends VirtualTable {
  // TypeScript ensures all required methods are implemented
  async xUpdate(operation: RowOp, values: Row | undefined): Promise<Row | undefined> {
    // Type-safe parameter handling
    if (operation === 'INSERT' && values) {
      return this.handleInsert(values);
    }
    return undefined;
  }
}

// Interface compliance is checked at compile time
class MyModule implements VirtualTableModule<MyTable, MyConfig> {
  // All required methods must be implemented with correct signatures
}
```

### IntelliSense and Documentation

IDEs provide rich autocomplete and inline documentation for all exported types:

- Method signatures with parameter types
- Enum values with descriptions  
- Interface properties with documentation
- Import suggestions for missing types

### Modern Planning Features

Access advanced query optimization through the modern planning API:

```typescript
// Use builder pattern for clean, type-safe plan construction
const plan = AccessPlanBuilder.eqMatch(1)
  .setHandledFilters([true, false, true])
  .setOrdering([{ columnIndex: 0, desc: false }])
  .setIsSet(true)
  .setExplanation('Primary key lookup')
  .build();
```

## Best Practices

### Error Handling

Always validate inputs and handle errors gracefully:

```javascript
function safeFunction(input) {
  try {
    if (input === null || input === undefined) return null;
    
    // Your logic here
    return result;
  } catch (error) {
    console.error('Plugin error:', error);
    return null; // Or throw a meaningful error
  }
}
```

### Performance

- Use generators for large datasets
- Implement proper caching where appropriate
- Avoid synchronous operations in async contexts

### Security

- Validate all user inputs
- Don't expose sensitive information
- Use secure defaults for configuration

### Documentation

- Document all functions and parameters
- Provide usage examples
- Include performance characteristics

## Installation & loading

### Programmatic loading

```typescript
import { Database } from '@quereus/quereus';
import { loadPlugin, dynamicLoadModule } from '@quereus/quereus/util/plugin-loader.js';

const db = new Database();

// 1) Load from npm package name (Node):
await loadPlugin('npm:@acme/quereus-plugin-foo@^1', db, { api_key: '...' });

// 2) Load from direct URL (Node or Browser):
await dynamicLoadModule('https://example.com/plugin.js', db, { timeout: 10000 });

// 3) Browser npm via CDN (opt-in only):
await loadPlugin('npm:@acme/quereus-plugin-foo@^1', db, { timeout: 8000 }, { allowCdn: true, cdn: 'jsdelivr' });
```

Behavior:
- npm package resolution prefers the `exports['./plugin']` subpath. In Node, the package is loaded directly. In browsers, npm resolution is disabled by default; enabling it requires `{ allowCdn: true }` and maps to a CDN URL.
- Version compatibility: if the package declares `engines.quereus` or a `peerDependency` on `@quereus/quereus`, hosts should throw when incompatible (error, not warning).

### Web UI

In Quoomb Web, the Plugin Manager accepts either:
- An npm package spec (e.g. `@acme/quereus-plugin-foo@^1`) — may require a CDN if running fully in-browser
- A direct ESM URL (e.g. a GitHub raw link)

The UI reads `manifest.settings` or `package.json.quereus.settings` to render configuration, and surfaces `quereus.provides` as capability badges.



## Troubleshooting

### Common Issues

1. **Plugin not loading** - Check console for error messages
2. **Function not found** - Verify function name and argument count
3. **Collation not working** - Ensure collation name is uppercase
4. **Virtual table errors** - Check schema format and scan method

### Debugging

Enable debug logging:

```javascript
// In your plugin
if (config.debug) {
  console.log('Debug info:', data);
}
```

Set the DEBUG environment variable:

```bash
DEBUG=quereus:* npm start
```

## Examples

See the `packages/sample-plugins/` directory for complete examples:

- `json-table/` - Virtual table for JSON data
- `string-functions/` - Additional string functions
- `custom-collations/` - Custom sorting behaviors
- `comprehensive-demo/` - All plugin types in one

## API Reference

All types are exported from the main `quereus` package for external plugin development.

### Core Virtual Table Types

```typescript
// Base class for virtual table implementations
abstract class VirtualTable {
  constructor(db: Database, module: VirtualTableModule<any, any>, schemaName: string, tableName: string);
  abstract xDisconnect(): Promise<void>;
  abstract xUpdate(operation: RowOp, values: Row | undefined, oldKeyValues?: Row): Promise<Row | undefined>;
  
  // Optional methods
  xQuery?(filterInfo: FilterInfo): AsyncIterable<Row>;
  createConnection?(): MaybePromise<VirtualTableConnection>;
  getBestAccessPlan?(request: BestAccessPlanRequest): BestAccessPlanResult;
  xBegin?(): Promise<void>;
  xCommit?(): Promise<void>;
  xRollback?(): Promise<void>;
  // ... other optional methods
}

// Module interface for creating and managing virtual table instances
interface VirtualTableModule<TTable extends VirtualTable, TConfig extends BaseModuleConfig> {
  xCreate(db: Database, tableSchema: TableSchema): TTable;
  xConnect(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string, options: TConfig): TTable;
  getBestAccessPlan?(db: Database, tableInfo: TableSchema, request: BestAccessPlanRequest): BestAccessPlanResult;
  xBestIndex(db: Database, tableInfo: TableSchema, indexInfo: IndexInfo): number;
  xDestroy(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string): Promise<void>;
}

// Base configuration interface
interface BaseModuleConfig {}

// Connection interface for transaction support
interface VirtualTableConnection {
  readonly connectionId: string;
  readonly tableName: string;
  begin(): MaybePromise<void>;
  commit(): MaybePromise<void>;
  rollback(): MaybePromise<void>;
  createSavepoint(index: number): MaybePromise<void>;
  releaseSavepoint(index: number): MaybePromise<void>;
  rollbackToSavepoint(index: number): MaybePromise<void>;
  disconnect(): MaybePromise<void>;
}
```

### Modern Query Planning Interface

```typescript
// Request object for query planning
interface BestAccessPlanRequest {
  columns: readonly ColumnMeta[];
  filters: readonly PredicateConstraint[];
  requiredOrdering?: readonly OrderingSpec[];
  limit?: number | null;
  estimatedRows?: number;
}

// Result object describing the chosen query plan
interface BestAccessPlanResult {
  handledFilters: readonly boolean[];
  residualFilter?: (row: any) => boolean;
  cost: number;
  rows: number | undefined;
  providesOrdering?: readonly OrderingSpec[];
  isSet?: boolean;
  explains?: string;
}

// Helper class for building access plans
class AccessPlanBuilder {
  static fullScan(estimatedRows: number): AccessPlanBuilder;
  static eqMatch(matchedRows: number, indexCost?: number): AccessPlanBuilder;
  static rangeScan(estimatedRows: number, indexCost?: number): AccessPlanBuilder;
  
  setCost(cost: number): this;
  setRows(rows: number | undefined): this;
  setHandledFilters(handledFilters: readonly boolean[]): this;
  setOrdering(ordering: readonly OrderingSpec[]): this;
  setIsSet(isSet: boolean): this;
  setExplanation(explanation: string): this;
  setResidualFilter(filter: (row: any) => boolean): this;
  build(): BestAccessPlanResult;
}

// Planning primitive types
interface ColumnMeta {
  index: number;
  name: string;
  type: SqlDataType;
  isPrimaryKey: boolean;
  isUnique: boolean;
}

interface PredicateConstraint {
  columnIndex: number;
  op: ConstraintOp;
  value?: SqlValue;
  usable: boolean;
}

interface OrderingSpec {
  columnIndex: number;
  desc: boolean;
  nullsFirst?: boolean;
}

type ConstraintOp = '=' | '>' | '>=' | '<' | '<=' | 'MATCH' | 'LIKE' | 'GLOB' | 'IS NULL' | 'IS NOT NULL';
```

### Legacy Planning Interface

```typescript
// Legacy IndexInfo interface for compatibility
interface IndexInfo {
  nConstraint: number;
  aConstraint: ReadonlyArray<IndexConstraint>;
  nOrderBy: number;
  aOrderBy: ReadonlyArray<IndexOrderBy>;
  colUsed: bigint;
  
  // Output fields
  aConstraintUsage: IndexConstraintUsage[];
  idxNum: number;
  idxStr: string | null;
  orderByConsumed: boolean;
  estimatedCost: number;
  estimatedRows: bigint;
  idxFlags: number;
}

interface IndexConstraint {
  iColumn: number;
  op: IndexConstraintOp;
  usable: boolean;
  iTermOffset?: number;
}

interface FilterInfo {
  idxNum: number;
  idxStr: string | null;
  constraints: ReadonlyArray<{ constraint: IndexConstraint, argvIndex: number }>;
  args: ReadonlyArray<SqlValue>;
  indexInfoOutput: IndexInfo;
}
```

### Constants and Enums

```typescript
enum IndexConstraintOp {
  EQ = 2, GT = 4, LE = 8, LT = 16, GE = 32,
  MATCH = 64, LIKE = 65, GLOB = 66, REGEXP = 67,
  NE = 68, ISNOT = 69, ISNOTNULL = 70, ISNULL = 71,
  IS = 72, LIMIT = 73, OFFSET = 74, IN = 75,
  FUNCTION = 150
}

enum IndexScanFlags {
  UNIQUE = 0x0001
}

enum VTabConfig {
  CONSTRAINT_SUPPORT = 1,
  INNOCUOUS = 2,
  DIRECTONLY = 3,
  USES_ALL_SCHEMAS = 4
}

enum FunctionFlags {
  UTF8 = 1,
  DETERMINISTIC = 0x000000800,
  DIRECTONLY = 0x000080000,
  INNOCUOUS = 0x000200000
}
```

### Plugin Registration Types

```typescript
interface PluginRegistrations {
  vtables?: VTablePluginInfo[];
  functions?: FunctionPluginInfo[];
  collations?: CollationPluginInfo[];
}

interface VTablePluginInfo {
  name: string;
  module: VirtualTableModule<any, any>;
  auxData?: unknown;
}

interface FunctionPluginInfo {
  schema: FunctionSchema;
}

interface CollationPluginInfo {
  name: string;
  func: CollationFunction;
}
```

### Collation Function Type

```typescript
type CollationFunction = (a: string, b: string) => number;
```

The function should return:
- `-1` if `a < b`
- `0` if `a === b`
- `1` if `a > b`

### Built-in Collations

```typescript
// Available collation functions
const BINARY_COLLATION: CollationFunction;    // Byte-by-byte comparison
const NOCASE_COLLATION: CollationFunction;    // Case-insensitive comparison  
const RTRIM_COLLATION: CollationFunction;     // Right-trim before comparison

// Collation management
function registerCollation(name: string, func: CollationFunction): void;
function getCollation(name: string): CollationFunction | undefined;
function resolveCollation(collationName: string): CollationFunction;
```
