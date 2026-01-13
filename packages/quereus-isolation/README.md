# @quereus/isolation

Generic transaction isolation layer for Quereus virtual table modules.

## Overview

The `@quereus/isolation` package provides MVCC-style transaction isolation semantics for any Quereus virtual table module. It wraps existing modules to add:

- **Read-your-own-writes** — See uncommitted changes within your transaction
- **Snapshot isolation** — Consistent reads throughout the transaction
- **Savepoint support** — Nested transaction control
- **ACID semantics** — Full transaction guarantees

This allows module authors to focus on storage concerns while getting isolation "for free."

## Installation

```bash
yarn add @quereus/isolation @quereus/quereus
```

## Quick Start

```typescript
import { Database, MemoryTableModule } from '@quereus/quereus';
import { IsolationModule } from '@quereus/isolation';

const db = new Database();

// Create any underlying module (memory, store, custom, etc.)
const memoryModule = new MemoryTableModule();

// Wrap it with the isolation layer
const isolatedModule = new IsolationModule({
	underlying: memoryModule,
});

db.registerModule('isolated', isolatedModule);

// Use it like any other module, but with full isolation
await db.exec(`CREATE TABLE users (
	id INTEGER PRIMARY KEY,
	name TEXT
) USING isolated`);

await db.exec('BEGIN');
await db.exec(`INSERT INTO users VALUES (1, 'Alice')`);

// Reads see uncommitted changes
const user = await db.get('SELECT * FROM users WHERE id = 1');
console.log(user.name); // 'Alice'

await db.exec('COMMIT'); // Or ROLLBACK
```

## Architecture

The isolation layer operates at the **row level**, merging query results from two modules:

1. **Overlay module** — Stores uncommitted changes (inserts, updates, deletes as tombstones)
2. **Underlying module** — Stores committed data

```
┌─────────────────────────────────────────────────────────┐
│                   IsolationModule                        │
│                                                          │
│  ┌────────────────────────────────────────────────────┐ │
│  │         Overlay Module (e.g., memory vtab)         │ │
│  │  - Stores pending inserts, updates, tombstones     │ │
│  │  - Per-connection isolation                        │ │
│  └────────────────────────────────────────────────────┘ │
│                          │                               │
│                          │ row-level merge               │
│                          ▼                               │
│  ┌────────────────────────────────────────────────────┐ │
│  │           Underlying Module (any)                   │ │
│  │  - LevelDB / IndexedDB store                       │ │
│  │  - Custom module without isolation                 │ │
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### Key Features

**Per-connection overlay** — Each database instance gets its own overlay storage, ensuring proper isolation between connections.

**Lazy overlay creation** — No memory overhead until the first write in a transaction.

**Configurable overlay module** — Use memory for fast transactions, or persistent storage for large transactions:

```typescript
import { IsolationModule } from '@quereus/isolation';
import { MemoryTableModule } from '@quereus/quereus';
import { StoreModule } from '@quereus/store';

// Fast, ephemeral overlay (default)
const isolatedModule = new IsolationModule({
	underlying: myStoreModule,
	overlay: new MemoryTableModule(),
});

// Or use persistent overlay for large transactions
const isolatedModule = new IsolationModule({
	underlying: myStoreModule,
	overlay: new StoreModule(tempStoreProvider),
});
```

## API

### `IsolationModule`

```typescript
class IsolationModule implements VirtualTableModule {
	constructor(config: IsolationModuleConfig);
	getCapabilities(): ModuleCapabilities;
}
```

#### Configuration

```typescript
interface IsolationModuleConfig {
	/** Module to wrap with isolation semantics */
	underlying: VirtualTableModule<any, any>;

	/** Optional overlay module (defaults to MemoryTableModule) */
	overlay?: VirtualTableModule<any, any>;

	/** Optional tombstone column name (defaults to '_tombstone') */
	tombstoneColumn?: string;
}
```

### Merge Utilities

The package also exports low-level utilities for merging sorted streams:

```typescript
import { mergeStreams, createMergeEntry, createTombstone } from '@quereus/isolation';

// Merge two sorted streams (overlay and underlying)
const merged = mergeStreams(overlayStream, underlyingStream, {
	comparePK: (a, b) => /* compare primary keys */,
	extractPK: (row) => /* extract PK from row */,
});
```

See the [design document](https://github.com/gotchoices/quereus/blob/main/packages/quereus/docs/design-isolation-layer.md) for detailed architecture and implementation notes.

## Use Cases

### Store Module Isolation

The `@quereus/store` package provides a convenience function:

```typescript
import { createIsolatedStoreModule } from '@quereus/store';
import { createLevelDBProvider } from '@quereus/plugin-leveldb';

const provider = createLevelDBProvider({ basePath: './data' });
const module = createIsolatedStoreModule({ provider });

db.registerModule('store', module);
```

### Custom Module Isolation

Wrap any custom module:

```typescript
import { IsolationModule } from '@quereus/isolation';
import { MyCustomModule } from './my-module';

const isolatedModule = new IsolationModule({
	underlying: new MyCustomModule(),
});
```

## Checking Capabilities

```typescript
const caps = isolatedModule.getCapabilities();
console.log(caps.isolation);  // true
console.log(caps.savepoints); // true
console.log(caps.persistent); // (from underlying module)
```

## Performance

The isolation layer adds minimal overhead:

- **Fast path** — No overlay merging if no writes have occurred
- **Point lookups** — O(log n) overlay check + underlying lookup
- **Range scans** — Streaming merge of sorted results

For performance-critical applications, consider:
- Using memory overlay for small transactions
- The memory vtab uses integrated isolation (no separate layer)

## Testing

```bash
yarn test
```

## License

MIT

## Related Packages

- [@quereus/quereus](https://www.npmjs.com/package/@quereus/quereus) — Core SQL engine
- [@quereus/store](https://www.npmjs.com/package/@quereus/store) — Abstract key-value storage
- [@quereus/plugin-leveldb](https://www.npmjs.com/package/@quereus/plugin-leveldb) — LevelDB storage
- [@quereus/plugin-indexeddb](https://www.npmjs.com/package/@quereus/plugin-indexeddb) — IndexedDB storage
