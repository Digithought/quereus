# @quereus/store-indexeddb

IndexedDB storage backend for [@quereus/plugin-store](../quereus-plugin-store/). Provides persistent storage for Quereus in browser environments.

## Features

- **Browser-native**: Uses IndexedDB for reliable persistent storage
- **Cross-tab sync**: BroadcastChannel-based synchronization across browser tabs
- **Two modes**: Per-table databases or unified single database
- **Async iteration**: Efficient range queries with cursor-based iteration

## Installation

```bash
npm install @quereus/store-indexeddb @quereus/plugin-store
```

## Quick Start

### With registerPlugin (Recommended)

```typescript
import { Database, registerPlugin } from '@quereus/quereus';
import storePlugin from '@quereus/plugin-store';

const db = new Database();
await registerPlugin(db, storePlugin);  // Auto-detects browser, uses IndexedDB

await db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT) USING store`);
```

### Direct Usage

```typescript
import { Database } from '@quereus/quereus';
import { IndexedDBModule } from '@quereus/store-indexeddb';

const db = new Database();
const module = new IndexedDBModule();
db.registerVtabModule('store', module);

await db.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)
  USING store(database='myapp')
`);
```

### Unified Mode (Recommended for Multi-Table)

For applications with multiple tables, use `UnifiedIndexedDBModule` which stores all tables in a single IndexedDB database:

```typescript
import { UnifiedIndexedDBModule } from '@quereus/store-indexeddb';

const module = new UnifiedIndexedDBModule({ databaseName: 'myapp' });
db.registerVtabModule('store', module);

// All tables share one IDB database
await db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT) USING store`);
await db.exec(`CREATE TABLE orders (id INTEGER PRIMARY KEY, total REAL) USING store`);

// Atomic cross-table writes
const batch = module.createMultiStoreBatch();
batch.putToStore('main.users', userKey, userData);
batch.putToStore('main.orders', orderKey, orderData);
await batch.write();  // Single transaction
```

## API

### IndexedDBStore

Low-level KVStore implementation:

```typescript
import { IndexedDBStore } from '@quereus/store-indexeddb';

const store = await IndexedDBStore.open({
  databaseName: 'myapp',
  storeName: 'users'
});

await store.put(key, value);
const data = await store.get(key);
await store.delete(key);

// Range iteration
for await (const { key, value } of store.iterate({ gte: startKey, lt: endKey })) {
  console.log(key, value);
}

await store.close();
```

### IndexedDBProvider

Factory for managing multiple stores:

```typescript
import { createIndexedDBProvider } from '@quereus/store-indexeddb';

const provider = createIndexedDBProvider({ prefix: 'myapp' });

const userStore = await provider.getStore('main', 'users');
const catalogStore = await provider.getCatalogStore();

await provider.closeAll();
```

### UnifiedIndexedDBManager

Single-database manager for all tables:

```typescript
import { UnifiedIndexedDBManager } from '@quereus/store-indexeddb';

const manager = new UnifiedIndexedDBManager({ databaseName: 'myapp' });
await manager.initialize();

const userStore = await manager.getStore('main.users');
const orderStore = await manager.getStore('main.orders');

// List all stores
const stores = manager.getStoreNames();  // ['main.users', 'main.orders']

await manager.close();
```

### CrossTabSync

Synchronize changes across browser tabs:

```typescript
import { CrossTabSync } from '@quereus/store-indexeddb';

const sync = new CrossTabSync('myapp');

sync.onDataChange((event) => {
  console.log('Tab change:', event.storeName, event.type, event.key);
  refreshUI();
});

// Broadcast a change to other tabs
sync.notifyDataChange('main.users', 'put', key);

sync.close();
```

## Configuration

### IndexedDBStore Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `databaseName` | string | required | IndexedDB database name |
| `storeName` | string | required | Object store name |

### UnifiedIndexedDBManager Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `databaseName` | string | 'quereus' | Single IDB database name |
| `crossTabSync` | boolean | true | Enable cross-tab synchronization |

## Related Packages

- [`@quereus/plugin-store`](../quereus-plugin-store/) - Core storage plugin
- [`@quereus/store-leveldb`](../quereus-store-leveldb/) - LevelDB backend for Node.js

## License

MIT

