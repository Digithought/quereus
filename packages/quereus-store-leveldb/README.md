# @quereus/store-leveldb

LevelDB storage backend for [@quereus/plugin-store](../quereus-plugin-store/). Provides persistent storage for Quereus in Node.js environments.

## Features

- **Fast**: LevelDB offers excellent read/write performance for key-value workloads
- **Sorted keys**: Efficient range queries with ordered iteration
- **ACID batches**: Atomic writes across multiple keys
- **Compression**: Built-in Snappy compression for reduced disk usage

## Installation

```bash
npm install @quereus/store-leveldb @quereus/plugin-store
```

## Quick Start

### With registerPlugin (Recommended)

```typescript
import { Database, registerPlugin } from '@quereus/quereus';
import storePlugin from '@quereus/plugin-store';

const db = new Database();
await registerPlugin(db, storePlugin);  // Auto-detects Node.js, uses LevelDB

await db.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)
  USING store(path='./data/users')
`);
```

### Direct Usage

```typescript
import { Database } from '@quereus/quereus';
import { LevelDBModule } from '@quereus/store-leveldb';

const db = new Database();
const module = new LevelDBModule();
db.registerVtabModule('leveldb', module);

await db.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)
  USING leveldb(path='./data/users')
`);
```

## API

### LevelDBStore

Low-level KVStore implementation:

```typescript
import { LevelDBStore } from '@quereus/store-leveldb';

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
import { createLevelDBProvider } from '@quereus/store-leveldb';

const provider = createLevelDBProvider({ basePath: './data' });

const userStore = await provider.getStore('main', 'users');  // ./data/main/users
const catalogStore = await provider.getCatalogStore();       // ./data/__catalog__

await provider.closeStore('main', 'users');
await provider.closeAll();
```

## Configuration

### LevelDBStore Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `path` | string | required | Directory path for the database |
| `createIfMissing` | boolean | true | Create database if it doesn't exist |
| `errorIfExists` | boolean | false | Error if database already exists |

### LevelDBProvider Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `basePath` | string | required | Base directory for all stores |

### LevelDBModule Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `path` | string | required | Path for the store (in CREATE TABLE) |
| `collation` | 'BINARY' \| 'NOCASE' | 'NOCASE' | Text key collation |

## Example with Transactions

```typescript
const db = new Database();
db.registerVtabModule('leveldb', new LevelDBModule());

await db.exec(`CREATE TABLE accounts (id INTEGER PRIMARY KEY, balance REAL) USING leveldb(path='./accounts')`);

await db.exec('BEGIN');
try {
  await db.exec(`UPDATE accounts SET balance = balance - 100 WHERE id = 1`);
  await db.exec(`UPDATE accounts SET balance = balance + 100 WHERE id = 2`);
  await db.exec('COMMIT');
} catch (e) {
  await db.exec('ROLLBACK');
  throw e;
}
```

## Related Packages

- [`@quereus/plugin-store`](../quereus-plugin-store/) - Core storage plugin
- [`@quereus/store-indexeddb`](../quereus-store-indexeddb/) - IndexedDB backend for browsers

## License

MIT

