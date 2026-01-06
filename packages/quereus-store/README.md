# @quereus/store

Abstract key-value storage module for [Quereus](https://github.com/gotchoices/quereus). Provides platform-agnostic interfaces and a generic `StoreModule` virtual table implementation.

## Architecture

This package provides the **abstract layer** that separates virtual table logic from platform-specific storage:

```
@quereus/store (this package)
├── KVStore interface           - Abstract key-value store
├── KVStoreProvider interface   - Store factory/management
├── StoreModule                 - Generic VirtualTableModule
├── StoreTable                  - Generic virtual table implementation
├── StoreConnection             - Generic transaction support
└── Common utilities            - Encoding, serialization, events

@quereus/plugin-leveldb (Node.js)     @quereus/plugin-indexeddb (Browser)
├── LevelDBStore                      ├── IndexedDBStore
├── LevelDBProvider                   ├── IndexedDBProvider
└── Plugin registration               ├── IndexedDBManager
                                      └── CrossTabSync
```

This architecture enables:
- **Platform portability** - Same SQL tables work across Node.js, browsers, and mobile
- **Custom storage backends** - Implement `KVStore` for IndexedDB, LevelDB, LMDB, or other "NoSQL" stores
- **Dependency injection** - Use `KVStoreProvider` for store management

## Installation

```bash
npm install @quereus/store
```

For platform-specific implementations:
```bash
# Node.js
npm install @quereus/plugin-leveldb

# Browser
npm install @quereus/plugin-indexeddb
```

## Usage

### With a Provider

```typescript
import { Database } from '@quereus/quereus';
import { StoreModule } from '@quereus/store';
import { createLevelDBProvider } from '@quereus/plugin-leveldb';
// OR: import { createIndexedDBProvider } from '@quereus/plugin-indexeddb';

const db = new Database();

// Create provider for your platform
const provider = createLevelDBProvider({ basePath: './data' });

// Create the generic store module with your provider
const storeModule = new StoreModule(provider);
db.registerModule('store', storeModule);

// Use it in SQL
await db.exec(`
  create table users (id integer primary key, name text)
  using store
`);
```

### Custom Storage Backend

Implement `KVStore` and `KVStoreProvider` to create custom storage backends:

```typescript
import type { KVStore, KVStoreProvider } from '@quereus/store';

class MyCustomStore implements KVStore {
  async get(key: Uint8Array) { /* ... */ }
  async put(key: Uint8Array, value: Uint8Array) { /* ... */ }
  async delete(key: Uint8Array) { /* ... */ }
  async has(key: Uint8Array) { /* ... */ }
  iterate(options?: IterateOptions) { /* ... */ }
  batch() { /* ... */ }
  async close() { /* ... */ }
}

class MyCustomProvider implements KVStoreProvider {
  async getStore(schemaName: string, tableName: string) {
    return new MyCustomStore(/* ... */);
  }
  async getCatalogStore() { /* ... */ }
  async closeStore(schemaName: string, tableName: string) { /* ... */ }
  async closeAll() { /* ... */ }
}

// Use it with StoreModule
const provider = new MyCustomProvider();
const module = new StoreModule(provider);
db.registerModule('store', module);
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

interface KVStoreProvider {
  getStore(schemaName: string, tableName: string): Promise<KVStore>;
  getCatalogStore(): Promise<KVStore>;
  closeStore(schemaName: string, tableName: string): Promise<void>;
  closeAll(): Promise<void>;
}
```

## API

### Core Exports

| Export | Description |
|--------|-------------|
| `KVStore` | Key-value store interface (type) |
| `KVStoreProvider` | Store factory interface (type) |
| `WriteBatch` | Batch write interface (type) |
| `IterateOptions` | Iteration options (type) |
| `StoreModule` | Generic VirtualTableModule |
| `StoreTable` | Virtual table implementation |
| `StoreConnection` | Transaction connection |
| `TransactionCoordinator` | Transaction management |
| `StoreEventEmitter` | Event system for data/schema changes |

### Encoding Utilities

| Export | Description |
|--------|-------------|
| `encodeValue` | Encode a SQL value to sortable bytes |
| `decodeValue` | Decode bytes back to SQL value |
| `encodeCompositeKey` | Encode multiple values as composite key |
| `decodeCompositeKey` | Decode composite key to values |
| `registerCollationEncoder` | Register custom collation |

### Serialization Utilities

| Export | Description |
|--------|-------------|
| `serializeRow` | Serialize a row to bytes |
| `deserializeRow` | Deserialize bytes to row |
| `serializeValue` | Serialize a single value |
| `deserializeValue` | Deserialize a single value |

### Key Building

| Export | Description |
|--------|-------------|
| `buildDataKey` | Build key for row data |
| `buildIndexKey` | Build key for index entry |
| `buildMetaKey` | Build key for metadata |
| `buildTableScanBounds` | Build bounds for table scan |

## Related Packages

- [`@quereus/plugin-leveldb`](../quereus-plugin-leveldb/) - LevelDB implementation for Node.js
- [`@quereus/plugin-indexeddb`](../quereus-plugin-indexeddb/) - IndexedDB implementation for browsers
- [`@quereus/sync`](../quereus-sync/) - CRDT sync layer

## License

MIT

