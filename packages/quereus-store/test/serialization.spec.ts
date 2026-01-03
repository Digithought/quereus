/**
 * Tests for row serialization utilities.
 */

import { expect } from 'chai';
import {
  serializeRow,
  deserializeRow,
  serializeValue,
  deserializeValue,
  serializeStats,
  deserializeStats,
} from '../src/common/serialization.js';

describe('Row Serialization', () => {
  describe('serializeRow / deserializeRow', () => {
    it('should serialize and deserialize simple rows', () => {
      const row = [1, 'hello', 3.14, null];
      const serialized = serializeRow(row);
      const deserialized = deserializeRow(serialized);

      expect(deserialized).to.deep.equal(row);
    });

    it('should handle bigint values', () => {
      const row = [BigInt('9007199254740993'), 'test'];
      const serialized = serializeRow(row);
      const deserialized = deserializeRow(serialized);

      expect(deserialized[0]).to.equal(BigInt('9007199254740993'));
      expect(deserialized[1]).to.equal('test');
    });

    it('should handle Uint8Array (blob) values', () => {
      const blob = new Uint8Array([1, 2, 3, 4, 5]);
      const row = ['prefix', blob, 'suffix'];
      const serialized = serializeRow(row);
      const deserialized = deserializeRow(serialized);

      expect(deserialized[0]).to.equal('prefix');
      expect(deserialized[1]).to.deep.equal(blob);
      expect(deserialized[2]).to.equal('suffix');
    });

    it('should handle empty rows', () => {
      const row: (string | number | null | bigint | Uint8Array | boolean)[] = [];
      const serialized = serializeRow(row);
      const deserialized = deserializeRow(serialized);

      expect(deserialized).to.deep.equal([]);
    });

    it('should handle rows with all null values', () => {
      const row = [null, null, null];
      const serialized = serializeRow(row);
      const deserialized = deserializeRow(serialized);

      expect(deserialized).to.deep.equal([null, null, null]);
    });

    it('should handle boolean values', () => {
      const row = [true, false, 'text'];
      const serialized = serializeRow(row);
      const deserialized = deserializeRow(serialized);

      expect(deserialized).to.deep.equal([true, false, 'text']);
    });

    it('should handle special float values', () => {
      // Note: JSON doesn't support Infinity/-Infinity (they become null)
      // and -0 becomes 0. This is expected behavior.
      const row = [0, 1.5, -1.5, 3.14159];
      const serialized = serializeRow(row);
      const deserialized = deserializeRow(serialized);

      expect(deserialized[0]).to.equal(0);
      expect(deserialized[1]).to.equal(1.5);
      expect(deserialized[2]).to.equal(-1.5);
      expect(deserialized[3]).to.equal(3.14159);
    });

    it('should handle unicode strings', () => {
      const row = ['Hello 世界', '🎉 emoji', 'Ñoño'];
      const serialized = serializeRow(row);
      const deserialized = deserializeRow(serialized);

      expect(deserialized).to.deep.equal(row);
    });
  });

  describe('serializeValue / deserializeValue', () => {
    it('should serialize and deserialize individual values', () => {
      const testCases = [
        null,
        42,
        3.14,
        'hello',
        true,
        false,
        BigInt('12345678901234567890'),
        new Uint8Array([1, 2, 3]),
      ];

      for (const value of testCases) {
        const serialized = serializeValue(value);
        const deserialized = deserializeValue(serialized);

        if (value instanceof Uint8Array) {
          expect(deserialized).to.deep.equal(value);
        } else {
          expect(deserialized).to.equal(value);
        }
      }
    });
  });

  describe('serializeStats / deserializeStats', () => {
    it('should serialize and deserialize table stats', () => {
      const stats = {
        rowCount: 1000,
        updatedAt: Date.now(),
      };

      const serialized = serializeStats(stats);
      const deserialized = deserializeStats(serialized);

      expect(deserialized).to.deep.equal(stats);
    });

    it('should handle zero row count', () => {
      const stats = {
        rowCount: 0,
        updatedAt: 0,
      };

      const serialized = serializeStats(stats);
      const deserialized = deserializeStats(serialized);

      expect(deserialized).to.deep.equal(stats);
    });
  });
});

