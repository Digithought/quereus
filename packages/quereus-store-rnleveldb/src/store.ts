import type { IterateOptions, KVEntry, KVStore, KVStoreOptions, WriteBatch } from '@quereus/plugin-store';
import { LevelDB, LevelDBWriteBatch } from 'rn-leveldb';

/**
 * React Native LevelDB-backed KVStore implementation.
 */
export class RNLevelDBStore implements KVStore {
  private readonly db: LevelDB;
  private closed = false;

  private constructor(db: LevelDB) {
    this.db = db;
  }

  static async open(options: KVStoreOptions): Promise<RNLevelDBStore> {
    const db = new LevelDB(options.path, options.createIfMissing ?? true, options.errorIfExists ?? false);
    return new RNLevelDBStore(db);
  }

  async get(key: Uint8Array): Promise<Uint8Array | undefined> {
    this.assertOpen();
    const buf = this.db.getBuf(toArrayBufferExact(key));
    if (buf === null) return undefined;
    return new Uint8Array(buf);
  }

  async put(key: Uint8Array, value: Uint8Array): Promise<void> {
    this.assertOpen();
    this.db.put(toArrayBufferExact(key), toArrayBufferExact(value));
  }

  async delete(key: Uint8Array): Promise<void> {
    this.assertOpen();
    this.db.delete(toArrayBufferExact(key));
  }

  async has(key: Uint8Array): Promise<boolean> {
    this.assertOpen();
    return this.db.getBuf(toArrayBufferExact(key)) !== null;
  }

  async *iterate(options?: IterateOptions): AsyncIterable<KVEntry> {
    this.assertOpen();

    const iterator = this.db.newIterator();
    try {
      seekIterator(iterator, options);

      let yielded = 0;
      const limit = options?.limit;

      while (iterator.valid()) {
        if (!withinBounds(iterator, options)) break;

        yield {
          key: new Uint8Array(iterator.keyBuf()),
          value: new Uint8Array(iterator.valueBuf()),
        };

        yielded++;
        if (limit !== undefined && yielded >= limit) break;

        if (options?.reverse) {
          iterator.prev();
        } else {
          iterator.next();
        }
      }
    } finally {
      iterator.close();
    }
  }

  batch(): WriteBatch {
    this.assertOpen();
    return new RNLevelDBWriteBatch(this.db);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  async approximateCount(options?: IterateOptions): Promise<number> {
    this.assertOpen();
    let count = 0;
    for await (const _ of this.iterate(options)) count++;
    return count;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('RNLevelDBStore is closed');
  }
}

class RNLevelDBWriteBatch implements WriteBatch {
  private readonly db: LevelDB;
  private batch = new LevelDBWriteBatch();

  constructor(db: LevelDB) {
    this.db = db;
  }

  put(key: Uint8Array, value: Uint8Array): void {
    this.batch.put(toArrayBufferExact(key), toArrayBufferExact(value));
  }

  delete(key: Uint8Array): void {
    this.batch.delete(toArrayBufferExact(key));
  }

  async write(): Promise<void> {
    this.db.write(this.batch);
    this.reset();
  }

  clear(): void {
    this.reset();
  }

  private reset(): void {
    this.batch.close();
    this.batch = new LevelDBWriteBatch();
  }
}

function toArrayBufferExact(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer;
  return bytes.slice().buffer;
}

function seekIterator(iterator: ReturnType<LevelDB['newIterator']>, options?: IterateOptions): void {
  const reverse = options?.reverse === true;

  if (reverse) {
    seekIteratorReverse(iterator, options);
    return;
  }

  if (options?.gt) {
    iterator.seek(toArrayBufferExact(options.gt));
    if (iterator.valid() && iterator.compareKey(toArrayBufferExact(options.gt)) === 0) {
      iterator.next();
    }
    return;
  }

  if (options?.gte) {
    iterator.seek(toArrayBufferExact(options.gte));
    return;
  }

  iterator.seekToFirst();
}

function seekIteratorReverse(iterator: ReturnType<LevelDB['newIterator']>, options?: IterateOptions): void {
  if (options?.lt) {
    const target = toArrayBufferExact(options.lt);
    iterator.seek(target);
    if (!iterator.valid()) {
      iterator.seekLast();
      return;
    }

    // seek() positions at first key >= target; we want strictly less than `lt`.
    iterator.prev();
    return;
  }

  if (options?.lte) {
    const target = toArrayBufferExact(options.lte);
    iterator.seek(target);
    if (!iterator.valid()) {
      iterator.seekLast();
      return;
    }

    // seek() positions at first key >= target.
    // If current key is > lte, step back once; if == lte, stay.
    if (iterator.compareKey(target) > 0) {
      iterator.prev();
    }
    return;
  }

  iterator.seekLast();
}

function withinBounds(iterator: ReturnType<LevelDB['newIterator']>, options?: IterateOptions): boolean {
  if (!options) return true;

  // Forward upper bounds
  if (!options.reverse) {
    if (options.lt) {
      if (iterator.compareKey(toArrayBufferExact(options.lt)) >= 0) return false;
    }
    if (options.lte) {
      if (iterator.compareKey(toArrayBufferExact(options.lte)) > 0) return false;
    }
    return true;
  }

  // Reverse lower bounds
  if (options.gt) {
    if (iterator.compareKey(toArrayBufferExact(options.gt)) <= 0) return false;
  }
  if (options.gte) {
    if (iterator.compareKey(toArrayBufferExact(options.gte)) < 0) return false;
  }

  return true;
}


