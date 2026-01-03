# @quereus/plugin-leveldb

LevelDB storage plugin for Quereus. Provides persistent storage for Node.js environments using the [`@quereus/store`](../quereus-store/) module.

## Features

- **Fast**: LevelDB offers excellent read/write performance for key-value workloads
- **Sorted keys**: Efficient range queries with ordered iteration
- **ACID batches**: Atomic writes across multiple keys
- **Compression**: Built-in Snappy compression for reduced disk usage

## Installation

```bash
npm install @quereus/plugin-leveldb @quereus/store
```

## Quick Start

### With registerPlugin (Recommended)

```typescript
import { Database, registerPlugin } from '@quereus/quereus';
import leveldbPlugin from '@quereus/plugin-leveldb/plugin';

const db = new Database();
await registerPlugin(db, leveldbPlugin, { basePath: './data' });

await db.exec(`
  create table users (id integer primary key, name text)
  using store
`);
```

### Direct Usage with Provider

```typescript
import { Database } from '@quereus/quereus';
import { createLevelDBProvider } from '@quereus/plugin-leveldb';
import { StoreModule } from '@quereus/store';

const db = new Database();
const provider = createLevelDBProvider({ basePath: './data' });
const storeModule = new StoreModule(provider);
db.registerVtabModule('store', storeModule);

await db.exec(`
  create table users (id integer primary key, name text)
  using store
`);
```

## API

### LevelDBStore

Low-level KVStore implementation:

```typescript
import { LevelDBStore } from '@quereus/plugin-leveldb';

const store = await LevelDBStore.open({ path: './data/mystore' });

await store.put(key, value);
const data = await store.get(key);
await store.delete(key);

// Range iteration
for await (const { key, value } of store.iterate({ gte: startKey, lt: endKey })) {
  console.log(key, value);
}

// Batch writes
const batch = store.batch();
batch.put(key1, value1);
batch.put(key2, value2);
batch.delete(key3);
await batch.write();

await store.close();
```

### LevelDBProvider

Factory for managing multiple stores:

```typescript
import { createLevelDBProvider } from '@quereus/plugin-leveldb';

const provider = createLevelDBProvider({ basePath: './data' });

const userStore = await provider.getStore('main', 'users');  // ./data/main/users
const catalogStore = await provider.getCatalogStore();       // ./data/__catalog__

await provider.closeStore('main', 'users');
await provider.closeAll();
```

## Configuration

### Plugin Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `basePath` | string | `'./data'` | Base directory for all stores |
| `createIfMissing` | boolean | `true` | Create directories if they don't exist |
| `moduleName` | string | `'store'` | Name to register the virtual table module under |

### LevelDBStore Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `path` | string | required | Directory path for the database |
| `createIfMissing` | boolean | `true` | Create database if it doesn't exist |

## Example with Transactions

```typescript
import { Database, registerPlugin } from '@quereus/quereus';
import leveldbPlugin from '@quereus/plugin-leveldb/plugin';

const db = new Database();
await registerPlugin(db, leveldbPlugin, { basePath: './data' });

await db.exec(`create table accounts (id integer primary key, balance real) using store`);

await db.exec('begin');
try {
  await db.exec(`update accounts set balance = balance - 100 where id = 1`);
  await db.exec(`update accounts set balance = balance + 100 where id = 2`);
  await db.exec('commit');
} catch (e) {
  await db.exec('rollback');
  throw e;
}
```

## Related Packages

- [`@quereus/store`](../quereus-store/) - Core storage module (StoreModule, StoreTable)
- [`@quereus/plugin-indexeddb`](../quereus-plugin-indexeddb/) - IndexedDB plugin for browsers

## License

MIT

