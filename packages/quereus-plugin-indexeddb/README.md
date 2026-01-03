# @quereus/plugin-indexeddb

IndexedDB storage plugin for Quereus. Provides persistent storage for browser environments using the [`@quereus/store`](../quereus-store/) module.

## Features

- **Browser-native**: Uses IndexedDB for reliable persistent storage
- **Cross-tab sync**: BroadcastChannel-based synchronization across browser tabs
- **Async iteration**: Efficient range queries with cursor-based iteration

## Installation

```bash
npm install @quereus/plugin-indexeddb @quereus/store
```

## Quick Start

### With registerPlugin (Recommended)

```typescript
import { Database, registerPlugin } from '@quereus/quereus';
import indexeddbPlugin from '@quereus/plugin-indexeddb/plugin';

const db = new Database();
await registerPlugin(db, indexeddbPlugin, { prefix: 'myapp' });

await db.exec(`create table users (id integer primary key, name text) using store`);
```

### Direct Usage with Provider

```typescript
import { Database } from '@quereus/quereus';
import { createIndexedDBProvider } from '@quereus/plugin-indexeddb';
import { StoreModule } from '@quereus/store';

const db = new Database();
const provider = createIndexedDBProvider({ prefix: 'myapp' });
const storeModule = new StoreModule(provider);
db.registerVtabModule('store', storeModule);

await db.exec(`create table users (id integer primary key, name text) using store`);
```

## API

### IndexedDBStore

Low-level KVStore implementation:

```typescript
import { IndexedDBStore } from '@quereus/plugin-indexeddb';

const store = await IndexedDBStore.open({ path: 'myapp_main_users' });

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
import { createIndexedDBProvider } from '@quereus/plugin-indexeddb';

const provider = createIndexedDBProvider({ prefix: 'myapp' });

const userStore = await provider.getStore('main', 'users');
const catalogStore = await provider.getCatalogStore();

await provider.closeAll();
```

### CrossTabSync

Synchronize changes across browser tabs:

```typescript
import { CrossTabSync } from '@quereus/plugin-indexeddb';

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

### Plugin Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `prefix` | string | `'quereus'` | Prefix for IndexedDB database names |
| `moduleName` | string | `'store'` | Name to register the virtual table module under |

### IndexedDBProvider Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `prefix` | string | `'quereus'` | Prefix for database names: `${prefix}_${schema}_${table}` |

## Related Packages

- [`@quereus/store`](../quereus-store/) - Core storage module (StoreModule, StoreTable)
- [`@quereus/plugin-leveldb`](../quereus-plugin-leveldb/) - LevelDB plugin for Node.js

## License

MIT

