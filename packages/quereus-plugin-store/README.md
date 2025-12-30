# @quereus/plugin-store

Persistent storage plugin for [Quereus](https://github.com/gotchoices/quereus) providing LevelDB (Node.js) and IndexedDB (browser) backends.

## Architecture

The store plugin uses a **platform abstraction layer** that separates the core virtual table logic from platform-specific storage:

```
@quereus/plugin-store (core)
├── KVStore interface           - Abstract key-value store
├── KVStoreProvider interface   - Store factory/management
├── StoreModule                 - Generic VirtualTableModule (takes KVStoreProvider)
├── StoreTable                  - Generic virtual table implementation
├── StoreConnection             - Generic transaction support
└── Common utilities            - Encoding, serialization, events

@quereus/store-leveldb (Node.js)      @quereus/store-indexeddb (Browser)
├── LevelDBStore                      ├── IndexedDBStore
└── LevelDBProvider                   ├── IndexedDBProvider
                                      └── CrossTabSync
```

This architecture enables:
- **Platform portability** - Same SQL tables work across Node.js, browsers, and mobile
- **Custom storage backends** - Implement `KVStore` for SQLite, LMDB, or cloud storage
- **Dependency injection** - Use `KVStoreProvider` for store management

## Installation

```bash
npm install @quereus/plugin-store
```

For platform-specific stores:
```bash
# Node.js
npm install @quereus/store-leveldb

# Browser
npm install @quereus/store-indexeddb
```

## Quick Start

The simplest way to use this plugin is with Quereus's `registerPlugin` helper, which auto-detects the platform:

```typescript
import { Database, registerPlugin } from '@quereus/quereus';
import storePlugin from '@quereus/plugin-store';

const db = new Database();
await registerPlugin(db, storePlugin);

// Create a persistent table
await db.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE
  ) USING store(path='./data/users')
`);

// Use it like any SQL table
await db.exec(`INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com')`);
const users = await db.all('SELECT * FROM users');
```

## Platform-Specific Usage

### Node.js (LevelDB)

```typescript
import { Database } from '@quereus/quereus';
import { LevelDBModule } from '@quereus/plugin-store';

const db = new Database();
const leveldbModule = new LevelDBModule();
db.registerVtabModule('leveldb', leveldbModule);

await db.exec(`
  CREATE TABLE data (id INTEGER PRIMARY KEY, value TEXT)
  USING leveldb(path='./mydata')
`);
```

### Browser (IndexedDB)

```typescript
import { Database } from '@quereus/quereus';
import { IndexedDBModule } from '@quereus/plugin-store';

const db = new Database();
const indexeddbModule = new IndexedDBModule();
db.registerVtabModule('indexeddb', indexeddbModule);

await db.exec(`
  CREATE TABLE data (id INTEGER PRIMARY KEY, value TEXT)
  USING indexeddb(database='myapp')
`);
```

### Browser (Unified IndexedDB - Recommended)

For applications with multiple tables, use `UnifiedIndexedDBModule` which stores all tables in a single IndexedDB database. This enables atomic cross-table transactions:

```typescript
import { Database } from '@quereus/quereus';
import { UnifiedIndexedDBModule } from '@quereus/plugin-store';

const db = new Database();
const module = new UnifiedIndexedDBModule();
db.registerVtabModule('store', module);

// All tables share the same IDB database
await db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT) USING store`);
await db.exec(`CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER) USING store`);

// Cross-table atomic writes (useful for sync operations)
const batch = module.createMultiStoreBatch();
batch.putToStore('main.users', key1, value1);
batch.putToStore('main.orders', key2, value2);
await batch.write();  // Atomic across both tables
```

## Features

- **Cross-platform**: LevelDB for Node.js, IndexedDB for browsers
- **Full SQL support**: CREATE TABLE, INSERT, UPDATE, DELETE, SELECT with JOINs, indexes, etc.
- **Transaction support**: BEGIN/COMMIT/ROLLBACK with savepoints
- **Secondary indexes**: Automatic index maintenance for fast lookups
- **Schema persistence**: Table definitions stored and recovered on reconnect
- **Cross-tab sync** (browser): Changes broadcast across browser tabs via BroadcastChannel

## Configuration

### LevelDB Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `path` | string | required | Path to the LevelDB database directory |
| `createIfMissing` | boolean | true | Create database if it doesn't exist |
| `collation` | 'BINARY' \| 'NOCASE' | 'NOCASE' | Text key collation |

### IndexedDB Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `database` | string | 'quereus' | Name of the IndexedDB database |
| `collation` | 'BINARY' \| 'NOCASE' | 'NOCASE' | Text key collation |
| `crossTabSync` | boolean | true | Enable cross-tab synchronization |

## Transaction Support

Both backends support full transaction semantics:

```typescript
await db.exec('BEGIN');
try {
  await db.exec(`INSERT INTO users (name, email) VALUES ('Bob', 'bob@example.com')`);
  await db.exec(`UPDATE accounts SET balance = balance - 100 WHERE user_id = 1`);
  await db.exec('COMMIT');
} catch (e) {
  await db.exec('ROLLBACK');
  throw e;
}
```

Savepoints are also supported:

```typescript
await db.exec('BEGIN');
await db.exec('SAVEPOINT sp1');
await db.exec(`INSERT INTO users (name) VALUES ('Test')`);
await db.exec('ROLLBACK TO sp1');  // Undo the insert
await db.exec('COMMIT');
```

## KVStore Interface

The `KVStore` interface is the foundation for all storage backends:

```typescript
interface KVStore {
  get(key: Uint8Array): Promise<Uint8Array | undefined>;
  put(key: Uint8Array, value: Uint8Array): Promise<void>;
  delete(key: Uint8Array): Promise<void>;
  has(key: Uint8Array): Promise<boolean>;
  iterate(options?: IterateOptions): AsyncIterable<KVEntry>;
  batch(): WriteBatch;
  close(): Promise<void>;
}
```

### Using KVStoreProvider

For dependency injection and store management, use `KVStoreProvider`:

```typescript
import { createLevelDBProvider } from '@quereus/store-leveldb';
// OR for browsers:
import { createIndexedDBProvider } from '@quereus/store-indexeddb';

// Node.js
const provider = createLevelDBProvider({ basePath: './data' });

// Browser
const provider = createIndexedDBProvider({ prefix: 'myapp' });

// Get stores for tables
const userStore = await provider.getStore('main', 'users');
const catalogStore = await provider.getCatalogStore();

// Clean up
await provider.closeAll();
```

### Custom Storage Backends

Implement `KVStore` to create custom storage backends:

```typescript
import type { KVStore, KVStoreProvider } from '@quereus/plugin-store';

class MyCustomStore implements KVStore {
  async get(key: Uint8Array) { /* ... */ }
  async put(key: Uint8Array, value: Uint8Array) { /* ... */ }
  // ... implement remaining methods
}

class MyCustomProvider implements KVStoreProvider {
  async getStore(schemaName: string, tableName: string) {
    return new MyCustomStore(/* ... */);
  }
  async getCatalogStore() { /* ... */ }
  async closeStore(schemaName: string, tableName: string) { /* ... */ }
  async closeAll() { /* ... */ }
}
```

### Using StoreModule with Custom Provider

Once you have a `KVStoreProvider`, use the generic `StoreModule` to create a virtual table module:

```typescript
import { Database } from '@quereus/quereus';
import { StoreModule } from '@quereus/plugin-store';

// Your custom provider (e.g., for React Native)
const provider = new MyCustomProvider({ path: './data' });

// Create the module with your provider
const module = new StoreModule(provider);

// Register it with the database
db.registerVtabModule('store', module);

// Now use it in SQL
await db.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)
  USING store
`);
```

This pattern enables any storage backend (React Native, SQLite, cloud, etc.) without modifying the core module logic.

## API

### Core Exports

- `KVStore` - Key-value store interface (type)
- `KVStoreProvider` - Store factory interface (type)
- `StoreModule` - Generic virtual table module (takes any `KVStoreProvider`)
- `StoreTable` - Generic virtual table class
- `StoreConnection` - Generic transaction connection
- `TransactionCoordinator` - Shared transaction management
- `StoreEventEmitter` - Event system for data/schema changes

### Module Exports

- `StoreModule` - **Recommended** - Generic module that works with any `KVStoreProvider`
- `LevelDBModule` - Node.js virtual table module (legacy, uses LevelDB directly)
- `IndexedDBModule` - Browser virtual table module (legacy, one IDB database per table)
- `UnifiedIndexedDBModule` - Browser module with single shared IDB database

### Store Exports

- `LevelDBStore` / `IndexedDBStore` - Low-level key-value store implementations
- `UnifiedIndexedDBStore` / `UnifiedIndexedDBManager` - Unified IDB store and manager
- `MultiStoreWriteBatch` - Atomic writes across multiple object stores
- `CrossTabSync` - Browser tab synchronization
- `platform` - `{ isNode: boolean, isBrowser: boolean }`

### Default Export

The default export is a plugin registration function for use with `registerPlugin()`.

## Related Packages

- [`@quereus/store-leveldb`](../quereus-store-leveldb/) - LevelDB store implementation for Node.js
- [`@quereus/store-indexeddb`](../quereus-store-indexeddb/) - IndexedDB store implementation for browsers
- [`@quereus/plugin-sync`](../quereus-plugin-sync/) - CRDT sync layer (uses `KVStore` for metadata)

## License

MIT

