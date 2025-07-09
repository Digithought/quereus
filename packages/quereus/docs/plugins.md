# Quereus Plugin System

Quereus provides a comprehensive plugin system that allows you to extend the database engine with custom functionality. Plugins can register three types of components:

- **Virtual Tables** - Custom data sources that appear as SQL tables
- **Functions** - Custom SQL functions (scalar, aggregate, table-valued)
- **Collations** - Custom text sorting and comparison behaviors

## Plugin Architecture

### Plugin Module Structure

A Quereus plugin is an ES module that exports:

1. **Manifest** - Metadata about the plugin
2. **Default export** - A registration function that returns what to register

```javascript
// Basic plugin structure
export const manifest = {
  name: 'My Plugin',
  version: '1.0.0',
  description: 'Example plugin',
  provides: {
    vtables: ['my_table'],
    functions: ['my_func'],
    collations: ['MY_COLLATION']
  }
};

export default function register(db, config) {
  // Plugin logic here
  return {
    vtables: [...],
    functions: [...],
    collations: [...]
  };
}
```

### Plugin Manifest

The manifest provides metadata about your plugin:

```javascript
export const manifest = {
  name: 'Plugin Name',           // Required: Display name
  version: '1.0.0',              // Required: Version string
  author: 'Your Name',           // Optional: Author name
  description: 'What it does',   // Optional: Description
  pragmaPrefix: 'my_plugin',     // Optional: PRAGMA prefix (defaults to name)
  
  // Configuration options
  settings: [
    {
      key: 'timeout',
      label: 'Request Timeout',
      type: 'number',
      default: 5000,
      help: 'HTTP request timeout in milliseconds'
    }
  ],
  
  // What the plugin provides (for UI display)
  provides: {
    vtables: ['table1', 'table2'],
    functions: ['func1', 'func2'],
    collations: ['COLLATION1']
  }
};
```

### Registration Function

The default export function receives the database instance and user configuration:

```javascript
export default function register(db, config = {}) {
  // Access config values
  const timeout = config.timeout || 5000;
  
  // Return what to register
  return {
    vtables: [/* vtable registrations */],
    functions: [/* function registrations */],
    collations: [/* collation registrations */]
  };
}
```

## Virtual Table Plugins

Virtual tables allow you to expose external data sources as SQL tables.

### Basic Virtual Table

```javascript
class MyTable {
  constructor(args, config) {
    this.data = [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' }
    ];
  }

  getSchema() {
    return 'CREATE TABLE my_table(id INTEGER, name TEXT)';
  }

  * scan() {
    for (const row of this.data) {
      yield row;
    }
  }

  getRowCount() {
    return this.data.length;
  }
}

const myTableModule = {
  create: async (tableName, args, config) => {
    const table = new MyTable(args, config);
    return {
      schema: table.getSchema(),
      vtable: table
    };
  },

  connect: async (tableName, args, config) => {
    // Usually same as create
    return myTableModule.create(tableName, args, config);
  }
};

export default function register(db, config) {
  return {
    vtables: [
      {
        name: 'my_table',
        module: myTableModule,
        auxData: config
      }
    ]
  };
}
```

### Usage

```sql
-- Create table using the plugin
CREATE TABLE users USING my_table();

-- Query the table
SELECT * FROM users WHERE id > 1;
```

## Function Plugins

Functions extend SQL with custom computational logic.

### Scalar Functions

Return a single value:

```javascript
function reverse(text) {
  if (text === null || text === undefined) return null;
  return String(text).split('').reverse().join('');
}

export default function register(db, config) {
  return {
    functions: [
      {
        schema: {
          name: 'reverse',
          numArgs: 1,
          flags: 1, // FunctionFlags.UTF8
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

```javascript
function numericCollation(a, b) {
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

## Installation

### Loading Plugins

```javascript
import { Database } from 'quereus';
import { dynamicLoadModule } from 'quereus/plugin-loader';

const db = new Database();

// Load from URL
await dynamicLoadModule('https://example.com/plugin.js', db, {
  timeout: 10000,
  debug: true
});

// Load from local file
await dynamicLoadModule('file:///path/to/plugin.js', db);
```

### Web UI

In Quoomb Web, use the Plugin Manager to:
1. Install plugins from URLs
2. Configure plugin settings
3. Enable/disable plugins
4. View plugin capabilities



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

### Plugin Registration Types

```typescript
interface PluginRegistrations {
  vtables?: VTablePluginInfo[];
  functions?: FunctionPluginInfo[];
  collations?: CollationPluginInfo[];
}

interface VTablePluginInfo {
  name: string;
  module: VirtualTableModule;
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

### Function Schema Types

```typescript
interface ScalarFunctionSchema {
  name: string;
  numArgs: number;
  flags: FunctionFlags;
  returnType: ScalarType;
  implementation: ScalarFunc;
}

interface TableValuedFunctionSchema {
  name: string;
  numArgs: number;
  flags: FunctionFlags;
  returnType: RelationType;
  implementation: TableValuedFunc;
}

interface AggregateFunctionSchema {
  name: string;
  numArgs: number;
  flags: FunctionFlags;
  returnType: ScalarType;
  stepFunction: AggregateReducer;
  finalizeFunction: AggregateFinalizer;
  initialValue?: any;
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