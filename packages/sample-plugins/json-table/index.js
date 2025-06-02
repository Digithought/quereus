/**
 * JSON_TABLE Plugin for Quereus
 *
 * This plugin demonstrates how to create a virtual table module for Quereus.
 * It allows reading JSON data from URLs or files as if it were a SQL table.
 *
 * Usage:
 *   CREATE VIRTUAL TABLE my_data USING json_table(
 *     'https://api.example.com/data.json',
 *     '$.items[*]'
 *   );
 *
 * Configuration:
 *   - timeout: HTTP request timeout in milliseconds
 *   - cache_ttl: Cache TTL for HTTP responses in seconds
 */

export const manifest = {
  name: 'JSON_TABLE',
  version: '1.0.0',
  author: 'Quereus Team',
  description: 'Virtual table module for reading JSON data from URLs or files',
  pragmaPrefix: 'json_table',
  settings: [
    {
      key: 'timeout',
      label: 'HTTP Timeout (ms)',
      type: 'number',
      default: 30000,
      help: 'Timeout for HTTP requests in milliseconds'
    },
    {
      key: 'cache_ttl',
      label: 'Cache TTL (seconds)',
      type: 'number',
      default: 300,
      help: 'Time-to-live for cached HTTP responses'
    },
    {
      key: 'user_agent',
      label: 'User Agent',
      type: 'string',
      default: 'Quereus JSON_TABLE Plugin/1.0.0',
      help: 'User agent string for HTTP requests'
    },
    {
      key: 'enable_cache',
      label: 'Enable Caching',
      type: 'boolean',
      default: true,
      help: 'Whether to cache HTTP responses'
    }
  ],
  capabilities: ['scan', 'filter']
};

// Simple in-memory cache
const cache = new Map();

/**
 * Fetches JSON data from a URL or file path
 */
async function fetchJsonData(url, config) {
  const timeout = config.timeout || 30000;
  const cacheKey = url;
  const cacheTtl = (config.cache_ttl || 300) * 1000; // Convert to ms
  const enableCache = config.enable_cache !== false;

  // Check cache first
  if (enableCache && cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    if (Date.now() - cached.timestamp < cacheTtl) {
      return cached.data;
    }
    cache.delete(cacheKey);
  }

  let data;

  if (url.startsWith('http://') || url.startsWith('https://')) {
    // Fetch from HTTP
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': config.user_agent || 'Quereus JSON_TABLE Plugin/1.0.0',
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
      throw new Error(`Failed to fetch JSON from ${url}: ${error.message}`);
    }
  } else if (url.startsWith('file://')) {
    // Read from file (Node.js environment)
    try {
      const fs = await import('fs/promises');
      const filePath = url.replace('file://', '');
      const content = await fs.readFile(filePath, 'utf-8');
      data = JSON.parse(content);
    } catch (error) {
      throw new Error(`Failed to read JSON file ${url}: ${error.message}`);
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
function evaluateJsonPath(data, path) {
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
function flattenObject(obj, prefix = '') {
  const result = {};

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
 * Virtual table implementation
 */
class JsonTable {
  constructor(args, config) {
    this.url = args[0];
    this.jsonPath = args[1] || '$';
    this.config = config;
    this.data = null;
    this.columns = null;
  }

  async initialize() {
    // Fetch and process data
    const rawData = await fetchJsonData(this.url, this.config);
    const items = evaluateJsonPath(rawData, this.jsonPath);

    if (!Array.isArray(items) || items.length === 0) {
      this.data = [];
      this.columns = [];
      return;
    }

    // Flatten all objects and determine schema
    const flattenedItems = items.map(item =>
      typeof item === 'object' ? flattenObject(item) : { value: item }
    );

    // Determine columns from all items
    const columnSet = new Set();
    for (const item of flattenedItems) {
      for (const key of Object.keys(item)) {
        columnSet.add(key);
      }
    }

    this.columns = Array.from(columnSet).sort();
    this.data = flattenedItems;
  }

  getSchema() {
    if (!this.columns) {
      throw new Error('Table not initialized');
    }

    // Generate CREATE TABLE statement
    const columnDefs = this.columns.map(col => `${col} TEXT`).join(', ');
    return `CREATE TABLE json_table(${columnDefs})`;
  }

  * scan() {
    if (!this.data) {
      throw new Error('Table not initialized');
    }

    for (const item of this.data) {
      // Ensure all columns are present
      const row = {};
      for (const col of this.columns) {
        row[col] = item[col] ?? null;
      }
      yield row;
    }
  }

  getRowCount() {
    return this.data ? this.data.length : 0;
  }
}

/**
 * Plugin registration function
 * This is called by Quereus when the plugin is loaded
 */
export default function register(db, config = {}) {
  // Register the virtual table module
  db.registerVirtualTableModule('json_table', {
    create: async (tableName, args) => {
      const table = new JsonTable(args, config);
      await table.initialize();
      return {
        schema: table.getSchema(),
        vtable: table
      };
    },

    connect: async (tableName, args) => {
      // Same as create for this simple implementation
      const table = new JsonTable(args, config);
      await table.initialize();
      return {
        schema: table.getSchema(),
        vtable: table
      };
    }
  });

  console.log(`JSON_TABLE plugin loaded with config:`, config);
}
