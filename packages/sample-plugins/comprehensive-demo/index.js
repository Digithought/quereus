/**
 * Comprehensive Demo Plugin for Quereus
 *
 * This plugin demonstrates all three types of registrations in one plugin:
 * - Virtual Table: A simple in-memory key-value store
 * - Functions: Math utilities and data conversion
 * - Collations: Case-insensitive with Unicode normalization
 *
 * This shows how a single plugin can provide multiple types of functionality.
 */

export const manifest = {
  name: 'Comprehensive Demo',
  version: '1.0.0',
  author: 'Quereus Team',
  description: 'Demonstrates all plugin types: vtables, functions, and collations',
  settings: [
    {
      key: 'default_precision',
      label: 'Default Precision',
      type: 'number',
      default: 2,
      help: 'Default decimal precision for math functions'
    },
    {
      key: 'enable_debug',
      label: 'Enable Debug Logging',
      type: 'boolean',
      default: false,
      help: 'Enable debug logging for plugin operations'
    }
  ],
  provides: {
    vtables: ['key_value_store'],
    functions: ['math_round_to', 'hex_to_int', 'int_to_hex', 'data_summary'],
    collations: ['UNICODE_CI']
  }
};

// In-memory storage for the key-value store
const stores = new Map();

/**
 * Virtual Table: Key-Value Store
 * Simple demonstration of an in-memory key-value store
 */
class KeyValueStore {
  constructor(args, config) {
    this.storeName = args[0] || 'default';
    this.config = config;
    
    // Initialize store if it doesn't exist
    if (!stores.has(this.storeName)) {
      stores.set(this.storeName, new Map());
    }
    
    this.store = stores.get(this.storeName);
  }

  getSchema() {
    return 'CREATE TABLE kv_store(key TEXT PRIMARY KEY, value TEXT)';
  }

  * scan() {
    for (const [key, value] of this.store) {
      yield { key, value };
    }
  }

  insert(row) {
    this.store.set(row.key, row.value);
    return { key: row.key, value: row.value };
  }

  update(oldRow, newRow) {
    this.store.delete(oldRow.key);
    this.store.set(newRow.key, newRow.value);
  }

  delete(row) {
    this.store.delete(row.key);
  }

  getRowCount() {
    return this.store.size;
  }
}

const keyValueModule = {
  xCreate: (db, tableSchema) => {
    const args = [tableSchema.vtabArgs && tableSchema.vtabArgs.store ? tableSchema.vtabArgs.store : 'default'];
    const table = new KeyValueStore(args, tableSchema.vtabArgs || {});
    // Minimal instance compatible with VirtualTable
    return {
      db,
      module: keyValueModule,
      schemaName: tableSchema.schemaName,
      tableName: tableSchema.name,
      tableSchema,
      xDisconnect: async () => {},
      async xUpdate(op, values) {
        if (op === 'insert' && values) {
          table.insert({ key: values[0], value: values[1] });
          return values;
        }
        return undefined;
      },
      *xQuery() {
        for (const row of table.scan()) {
          yield [row.key, row.value];
        }
      },
      async createConnection() {
        return {
          connectionId: 'kv:' + tableSchema.schemaName + '.' + tableSchema.name,
          tableName: tableSchema.name,
          begin: async () => {},
          commit: async () => {},
          rollback: async () => {},
          createSavepoint: async () => {},
          releaseSavepoint: async () => {},
          rollbackToSavepoint: async () => {},
          disconnect: async () => {}
        };
      }
    };
  },
  xConnect: (db, _pAux, _moduleName, schemaName, tableName, options) => {
    const tableSchema = {
      name: tableName,
      schemaName,
      columns: [
        { name: 'key', type: 3, notNull: false },
        { name: 'value', type: 3, notNull: false }
      ],
      columnIndexMap: new Map([[0,0],[1,1]]),
      primaryKeyDefinition: [{ name: 'key', index: 0 }],
      checkConstraints: [],
      isTemporary: false,
      isView: false,
      vtabModuleName: 'key_value_store',
      vtabArgs: options || {},
      estimatedRows: 0
    };
    return keyValueModule.xCreate(db, tableSchema);
  }
};

/**
 * Functions: Math and Data Utilities
 */

// Round to specific precision
function mathRoundTo(value, precision) {
  if (value === null || value === undefined) return null;
  if (precision === null || precision === undefined) return null;
  
  const num = Number(value);
  const prec = Math.max(0, Math.floor(Number(precision)));
  const factor = Math.pow(10, prec);
  
  return Math.round(num * factor) / factor;
}

// Convert hex string to integer
function hexToInt(hexStr) {
  if (hexStr === null || hexStr === undefined) return null;
  
  const str = String(hexStr).replace(/^0x/i, '');
  const result = parseInt(str, 16);
  
  return isNaN(result) ? null : result;
}

// Convert integer to hex string
function intToHex(intVal) {
  if (intVal === null || intVal === undefined) return null;
  
  const num = Number(intVal);
  if (!Number.isInteger(num)) return null;
  
  return '0x' + num.toString(16).toUpperCase();
}

// Table-valued function that returns data summary
function* dataSummary(jsonData) {
  if (jsonData === null || jsonData === undefined) return;
  
  let data;
  try {
    data = JSON.parse(String(jsonData));
  } catch (e) {
    yield { property: 'error', value: 'Invalid JSON' };
    return;
  }
  
  if (Array.isArray(data)) {
    yield { property: 'type', value: 'array' };
    yield { property: 'length', value: data.length };
    
    if (data.length > 0) {
      const firstType = typeof data[0];
      yield { property: 'first_element_type', value: firstType };
    }
  } else if (typeof data === 'object' && data !== null) {
    yield { property: 'type', value: 'object' };
    const keys = Object.keys(data);
    yield { property: 'key_count', value: keys.length };
    
    if (keys.length > 0) {
      yield { property: 'first_key', value: keys[0] };
    }
  } else {
    yield { property: 'type', value: typeof data };
    yield { property: 'value', value: String(data) };
  }
}

/**
 * Collations: Unicode Case-Insensitive
 */
function unicodeCaseInsensitive(a, b) {
  // Use proper Unicode normalization and case folding
  const normalize = (str) => {
    return str.normalize('NFD').toLowerCase().normalize('NFC');
  };
  
  const normA = normalize(a);
  const normB = normalize(b);
  
  return normA < normB ? -1 : normA > normB ? 1 : 0;
}

/**
 * Plugin registration function
 */
export default function register(db, config = {}) {
  const precision = config.default_precision || 2;
  const debug = config.enable_debug || false;
  
  if (debug) {
    console.log('Comprehensive Demo plugin loaded with config:', config);
  }
  
  return {
    // Virtual table registration
    vtables: [
      {
        name: 'key_value_store',
        module: keyValueModule,
        auxData: config
      }
    ],
    
    // Function registrations
    functions: [
      {
        schema: {
          name: 'math_round_to',
          numArgs: 2,
          flags: 1, // FunctionFlags.UTF8
          returnType: { typeClass: 'scalar', sqlType: 'REAL' },
          implementation: mathRoundTo
        }
      },
      {
        schema: {
          name: 'hex_to_int',
          numArgs: 1,
          flags: 1, // FunctionFlags.UTF8
          returnType: { typeClass: 'scalar', sqlType: 'INTEGER' },
          implementation: hexToInt
        }
      },
      {
        schema: {
          name: 'int_to_hex',
          numArgs: 1,
          flags: 1, // FunctionFlags.UTF8
          returnType: { typeClass: 'scalar', sqlType: 'TEXT' },
          implementation: intToHex
        }
      },
      {
        schema: {
          name: 'data_summary',
          numArgs: 1,
          flags: 1, // FunctionFlags.UTF8
          returnType: { 
            typeClass: 'relation',
            columns: [
              { name: 'property', type: 'TEXT' },
              { name: 'value', type: 'TEXT' }
            ]
          },
          implementation: dataSummary
        }
      }
    ],
    
    // Collation registrations
    collations: [
      {
        name: 'UNICODE_CI',
        func: unicodeCaseInsensitive
      }
    ]
  };
}