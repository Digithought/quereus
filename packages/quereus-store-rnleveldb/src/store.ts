import type { IterateOptions, KVEntry, KVStore, KVStoreOptions, WriteBatch } from '@quereus/plugin-store';

/**
 * Placeholder store. This will be implemented once we inspect the `react-native-leveldb` API.
 */
export class RNLevelDBStore implements KVStore {
  private closed = false;

  private constructor() {}

  static async open(_options: KVStoreOptions): Promise<RNLevelDBStore> {
    // TODO: Implement using react-native-leveldb once installed and inspected.
    return new RNLevelDBStore();
  }

  async get(_key: Uint8Array): Promise<Uint8Array | undefined> {
    this.assertOpen();
    throw new Error('RNLevelDBStore.get not implemented');
  }

  async put(_key: Uint8Array, _value: Uint8Array): Promise<void> {
    this.assertOpen();
    throw new Error('RNLevelDBStore.put not implemented');
  }

  async delete(_key: Uint8Array): Promise<void> {
    this.assertOpen();
    throw new Error('RNLevelDBStore.delete not implemented');
  }

  async has(_key: Uint8Array): Promise<boolean> {
    this.assertOpen();
    throw new Error('RNLevelDBStore.has not implemented');
  }

  async *iterate(_options?: IterateOptions): AsyncIterable<KVEntry> {
    this.assertOpen();
    throw new Error('RNLevelDBStore.iterate not implemented');
  }

  batch(): WriteBatch {
    this.assertOpen();
    throw new Error('RNLevelDBStore.batch not implemented');
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async approximateCount(_options?: IterateOptions): Promise<number> {
    this.assertOpen();
    // Fallback implementation can iterate and count later.
    throw new Error('RNLevelDBStore.approximateCount not implemented');
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('RNLevelDBStore is closed');
  }
}


