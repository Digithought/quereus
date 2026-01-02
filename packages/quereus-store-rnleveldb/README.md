# @quereus/store-rnleveldb

React Native persistent storage backend for Quereus, implemented as a `KVStore` / `KVStoreProvider` using LevelDB.

## Why this exists

Quereus’ store layer relies on **atomic batching** (`WriteBatch`) to commit groups of key/value mutations safely and efficiently.

React Native does not have a standard “Node-style” LevelDB binding, so this package provides the glue between:
- Quereus’ `@quereus/plugin-store` abstractions (`KVStore`, `WriteBatch`, `KVStoreProvider`)
- A React Native LevelDB native module (`rn-leveldb`)

## Dependency: rn-leveldb

This package depends on `rn-leveldb`, a fork of `react-native-leveldb` that exposes **native LevelDB `WriteBatch`** support to JS/TS:
- `LevelDBWriteBatch` for building a batch
- `db.write(batch)` to apply it atomically at the LevelDB layer

## Architecture notes (current)

- **Per-table database**: `RNLevelDBProvider` maps each `(schema, table)` to a distinct LevelDB database name.
  - Consequence: atomicity is **within one table/store at a time** (one underlying DB per table).
- **Batching**: `RNLevelDBStore.batch()` returns a `WriteBatch` that uses `LevelDBWriteBatch` under the hood and commits via `db.write(batch)`.

## Usage

Typical usage is through `StoreModule`:

```ts
import { Database } from '@quereus/quereus';
import { StoreModule } from '@quereus/plugin-store/common';
import { createRNLevelDBProvider } from '@quereus/store-rnleveldb';

const db = new Database();
const provider = createRNLevelDBProvider({ basePath: 'quereus' });
db.registerVtabModule('store', new StoreModule(provider));
```


