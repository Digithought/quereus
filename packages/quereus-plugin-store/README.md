# quereus-plugin-store

Persistent storage plugin for [Quereus](https://github.com/gotchoices/quereus) providing LevelDB (Node.js) and IndexedDB (browser) backends.

## Installation

```bash
npm install quereus-plugin-store
```

## Quick Start

The simplest way to use this plugin is with Quereus's `registerPlugin` helper, which auto-detects the platform:

```typescript
import { Database, registerPlugin } from '@quereus/quereus';
import storePlugin from 'quereus-plugin-store';

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
import { LevelDBModule } from 'quereus-plugin-store';

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
import { IndexedDBModule } from 'quereus-plugin-store';

const db = new Database();
const indexeddbModule = new IndexedDBModule();
db.registerVtabModule('indexeddb', indexeddbModule);

await db.exec(`
  CREATE TABLE data (id INTEGER PRIMARY KEY, value TEXT)
  USING indexeddb(database='myapp')
`);
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

## API

### Exports

- `LevelDBModule` - Node.js virtual table module
- `IndexedDBModule` - Browser virtual table module  
- `LevelDBStore` / `IndexedDBStore` - Low-level key-value store
- `LevelDBConnection` / `IndexedDBConnection` - Transaction connection
- `TransactionCoordinator` - Shared transaction management
- `CrossTabSync` - Browser tab synchronization
- `platform` - `{ isNode: boolean, isBrowser: boolean }`

### Default Export

The default export is a plugin registration function for use with `registerPlugin()`.

## License

MIT

