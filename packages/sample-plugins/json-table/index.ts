/**
 * JSON_TABLE Plugin for Quereus
 *
 * This plugin demonstrates how to create a virtual table module for Quereus.
 * It allows reading JSON data from URLs or files as if it were a SQL table.
 *
 * Usage:
 *   CREATE TABLE my_data USING json_table(
 *     'https://api.example.com/data.json',
 *     '$.items[*]'
 *   );
 *
 * Configuration:
 *   - timeout: HTTP request timeout in milliseconds
 *   - cache_ttl: Cache TTL for HTTP responses in seconds
 */

import type { Database, SqlValue } from '@quereus/quereus';

// Simple in-memory cache
const cache = new Map<string, { data: any; timestamp: number }>();

function isFileUrl(u: string): boolean {
  return u.startsWith('file:');
}

/**
 * Fetches JSON data from a URL or file path
 */
async function fetchJsonData(url: string, config: Record<string, SqlValue>): Promise<any> {
  const timeout = (config.timeout as number) || 30000;
  const cacheKey = url;
  const cacheTtl = ((config.cache_ttl as number) || 300) * 1000; // Convert to ms
  const enableCache = config.enable_cache !== false;

  // Check cache first
  if (enableCache && cache.has(cacheKey)) {
    const cached = cache.get(cacheKey)!;
    if (Date.now() - cached.timestamp < cacheTtl) {
      return cached.data;
    }
    cache.delete(cacheKey);
  }

  let data: any;

  if (url.startsWith('http://') || url.startsWith('https://')) {
    // Fetch from HTTP
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': (config.user_agent as string) || 'Quereus JSON_TABLE Plugin/1.0.0',
          'Accept': 'application/json'
        }
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      data = await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw new Error(`Failed to fetch JSON from ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (isFileUrl(url)) {
    // Read from file (Node.js environment)
    try {
      const fs = await import('fs/promises');
      const filePath = url.replace(/^file:\/\//, '');
      const content = await fs.readFile(filePath, 'utf-8');
      data = JSON.parse(content);
    } catch (error) {
      throw new Error(`Failed to read JSON file ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    throw new Error(`Unsupported URL scheme: ${url}`);
  }

  // Cache the result
  if (enableCache) {
    cache.set(cacheKey, {
      data,
      timestamp: Date.now()
    });
  }

  return data;
}

/**
 * Evaluates a JSONPath expression on data
 */
function evaluateJsonPath(data: any, path: string): any[] {
  // Simple JSONPath implementation for demo purposes
  // In a real plugin, you'd want to use a proper JSONPath library

  if (!path || path === '$') {
    return Array.isArray(data) ? data : [data];
  }

  // Handle simple array access like $.items[*]
  if (path.startsWith('$.') && path.endsWith('[*]')) {
    const property = path.slice(2, -3);
    const value = data[property];
    return Array.isArray(value) ? value : [];
  }

  // Handle simple property access like $.items
  if (path.startsWith('$.')) {
    const property = path.slice(2);
    const value = data[property];
    return Array.isArray(value) ? value : [value];
  }

  return Array.isArray(data) ? data : [data];
}

/**
 * Flattens an object into column-friendly format
 */
function flattenObject(obj: any, prefix = ''): Record<string, any> {
  const result: Record<string, any> = {};

  for (const [key, value] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}_${key}` : key;

    if (value === null || value === undefined) {
      result[newKey] = null;
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, flattenObject(value, newKey));
    } else if (Array.isArray(value)) {
      result[newKey] = JSON.stringify(value);
    } else {
      result[newKey] = value;
    }
  }

  return result;
}

/**
 * Plugin registration function
 * This is called by Quereus when the plugin is loaded
 */
export default function register(db: Database, config: Record<string, SqlValue> = {}) {
  console.log(`JSON_TABLE plugin loaded with config:`, config);

  // Virtual table module implementation
  const jsonTableModule = {
    // Engine calls xCreate(db, tableSchema)
    xCreate: (db: Database, tableSchema: any) => {
      // Build instance compatible with VirtualTable interface shape
      const instance = {
        db,
        module: jsonTableModule,
        schemaName: tableSchema.schemaName,
        tableName: tableSchema.name,
        tableSchema,
        _data: null as any[] | null,
        _columns: null as string[] | null,
        async _init() {
          const args = tableSchema.vtabArgs || {};
          const url = typeof args.url === 'string' ? args.url : '';
          const inline = typeof args.inline === 'string' ? args.inline : undefined;
          const path = typeof args.path === 'string' ? args.path : '$';

          let rawData: any;
          if (inline !== undefined) {
            try { rawData = JSON.parse(inline); } catch { rawData = []; }
          } else {
            rawData = await fetchJsonData(url, args);
          }
          const items = evaluateJsonPath(rawData, path);
          this._data = Array.isArray(items) ? items : [];
          // Use declared columns; if none, default to single 'value'
          this._columns = tableSchema.columns && tableSchema.columns.length > 0
            ? tableSchema.columns.map((c: any) => c.name)
            : ['value'];
        },
        async xDisconnect() { /* no-op */ },
        async xUpdate() { return undefined; },
        async *xQuery() {
          if (!this._data) {
            await this._init();
          }
          const cols = this._columns!;
          for (const item of this._data!) {
            if (cols.length === 1 && cols[0] === 'value') {
              yield [typeof item === 'object' ? JSON.stringify(item) : item];
            } else {
              // Map by flattened object properties when multiple columns declared
              const flat = typeof item === 'object' ? flattenObject(item) : { value: item };
              yield cols.map(name => Object.prototype.hasOwnProperty.call(flat, name) ? flat[name] : null);
            }
          }
        }
      };
      return instance;
    },
    // Connect is same as create for this simple module
    xConnect: (db: Database, _pAux: unknown, _moduleName: string, schemaName: string, tableName: string, options: any) => {
      const tableSchema = {
        name: tableName,
        schemaName,
        columns: [{ name: 'value', type: 3, notNull: false, defaultValue: undefined, collate: undefined, hidden: false }],
        columnIndexMap: new Map([[0, 0]]),
        primaryKeyDefinition: [],
        checkConstraints: [],
        isTemporary: false,
        isView: false,
        vtabModuleName: 'json_table',
        vtabArgs: options || {},
        estimatedRows: 0
      };
      return jsonTableModule.xCreate(db, tableSchema);
    }
  };

  // Return what we want to register
  return {
    vtables: [
      {
        name: 'json_table',
        module: jsonTableModule,
        auxData: config
      }
    ]
  };
}

