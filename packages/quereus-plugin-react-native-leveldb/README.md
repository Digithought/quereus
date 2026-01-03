# @quereus/plugin-react-native-leveldb

LevelDB storage plugin for Quereus on React Native. Provides fast, persistent storage for mobile iOS and Android applications using the [`@quereus/store`](../quereus-store/) module.

## Features

- **Fast**: LevelDB offers excellent read/write performance, significantly faster than AsyncStorage
- **Synchronous API**: Uses react-native-leveldb's synchronous, blocking APIs
- **Binary data**: Full support for binary keys and values via ArrayBuffers
- **Sorted keys**: Efficient range queries with ordered iteration
- **Persistent**: Data survives app restarts

## Installation

```bash
npm install @quereus/plugin-react-native-leveldb @quereus/store react-native-leveldb

# Don't forget to link native modules
cd ios && pod install
```

## Quick Start

### With registerPlugin (Recommended)

```typescript
import { LevelDB } from 'react-native-leveldb';
import { Database, registerPlugin } from '@quereus/quereus';
import leveldbPlugin from '@quereus/plugin-react-native-leveldb/plugin';

const db = new Database();
await registerPlugin(db, leveldbPlugin, { openFn: LevelDB.open });

await db.exec(`
  create table users (id integer primary key, name text)
  using store
`);

await db.exec(`insert into users (id, name) values (1, 'Alice')`);

const users = await db.all('select * from users');
console.log(users);
```

### Direct Usage with Provider

```typescript
import { LevelDB } from 'react-native-leveldb';
import { Database } from '@quereus/quereus';
import { createReactNativeLevelDBProvider } from '@quereus/plugin-react-native-leveldb';
import { StoreModule } from '@quereus/store';

const db = new Database();
const provider = createReactNativeLevelDBProvider({ openFn: LevelDB.open });
const storeModule = new StoreModule(provider);
db.registerVtabModule('store', storeModule);

await db.exec(`
  create table users (id integer primary key, name text)
  using store
`);
```

## API

### ReactNativeLevelDBStore

Low-level KVStore implementation:

```typescript
import { LevelDB } from 'react-native-leveldb';
import { ReactNativeLevelDBStore } from '@quereus/plugin-react-native-leveldb';

// Open using the factory function
const store = ReactNativeLevelDBStore.open(LevelDB.open, 'mystore');

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

### ReactNativeLevelDBProvider

Factory for managing multiple stores:

```typescript
import { LevelDB } from 'react-native-leveldb';
import { createReactNativeLevelDBProvider } from '@quereus/plugin-react-native-leveldb';

const provider = createReactNativeLevelDBProvider({
  openFn: LevelDB.open,
  databaseName: 'myapp',
});

const userStore = await provider.getStore('main', 'users');
const catalogStore = await provider.getCatalogStore();

await provider.closeStore('main', 'users');
await provider.closeAll();
```

## Configuration

### Plugin Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `openFn` | function | **required** | The LevelDB.open function from react-native-leveldb |
| `databaseName` | string | `'quereus'` | Base name prefix for all LevelDB databases |
| `createIfMissing` | boolean | `true` | Create databases if they don't exist |
| `moduleName` | string | `'store'` | Name to register the virtual table module under |

## Example with Transactions

```typescript
import { LevelDB } from 'react-native-leveldb';
import { Database, registerPlugin } from '@quereus/quereus';
import leveldbPlugin from '@quereus/plugin-react-native-leveldb/plugin';

const db = new Database();
await registerPlugin(db, leveldbPlugin, { openFn: LevelDB.open });

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

## Why LevelDB?

react-native-leveldb provides significant performance advantages over other React Native storage options:

| Storage Solution | Operations/sec | Notes |
|------------------|----------------|-------|
| react-native-leveldb | ~50,000 | Synchronous, blocking API |
| AsyncStorage | ~2,000 | JSON serialization overhead |
| react-native-sqlite-storage | ~5,000 | Full SQL parsing overhead |

LevelDB is ideal for Quereus because:
- **Sorted keys**: Natural fit for the StoreModule's index-organized storage
- **Binary support**: No JSON serialization needed for keys/values
- **Range scans**: Efficient ordered iteration for query execution

## Peer Dependencies

This plugin requires:
- `@quereus/quereus` ^0.24.0
- `@quereus/store` ^0.3.5
- `react-native-leveldb` ^3.0.0

## Related Packages

- [`@quereus/store`](../quereus-store/) - Core storage module (StoreModule, StoreTable)
- [`@quereus/plugin-leveldb`](../quereus-plugin-leveldb/) - LevelDB plugin for Node.js
- [`@quereus/plugin-indexeddb`](../quereus-plugin-indexeddb/) - IndexedDB plugin for browsers

## License

MIT

