/**
 * Tests for key encoding utilities.
 */

import { expect } from 'chai';
import {
  encodeValue,
  encodeCompositeKey,
  decodeValue,
  decodeCompositeKey,
} from '../src/common/encoding.js';

describe('Key Encoding', () => {
  describe('encodeValue / decodeValue', () => {
    it('should encode and decode NULL', () => {
      const encoded = encodeValue(null);
      expect(encoded).to.deep.equal(new Uint8Array([0x00]));

      const { value, bytesRead } = decodeValue(encoded);
      expect(value).to.be.null;
      expect(bytesRead).to.equal(1);
    });

    it('should encode and decode positive integers', () => {
      const testCases = [0n, 1n, 127n, 128n, 255n, 256n, 65535n, 2147483647n, 9007199254740991n];

      for (const num of testCases) {
        const encoded = encodeValue(num);
        const { value } = decodeValue(encoded);
        expect(value).to.equal(num, `Failed for ${num}`);
      }
    });

    it('should encode and decode negative integers', () => {
      const testCases = [-1n, -127n, -128n, -255n, -256n, -65535n, -2147483648n];

      for (const num of testCases) {
        const encoded = encodeValue(num);
        const { value } = decodeValue(encoded);
        expect(value).to.equal(num, `Failed for ${num}`);
      }
    });

    it('should preserve integer sort order', () => {
      const values = [-1000n, -1n, 0n, 1n, 1000n];
      const encoded = values.map(v => encodeValue(v));

      for (let i = 0; i < encoded.length - 1; i++) {
        const cmp = compareBytes(encoded[i], encoded[i + 1]);
        expect(cmp).to.be.lessThan(0, `${values[i]} should sort before ${values[i + 1]}`);
      }
    });

    it('should encode and decode floating point numbers', () => {
      // Note: Integer-valued floats like 0.0 are encoded as integers
      // Only test actual non-integer floats here
      const testCases = [0.5, 1.5, -1.5, 3.14159, -3.14159];

      for (const num of testCases) {
        const encoded = encodeValue(num);
        const { value } = decodeValue(encoded);
        expect(value).to.equal(num, `Failed for ${num}`);
      }
    });

    it('should preserve float sort order', () => {
      // Use non-integer floats to ensure they're encoded as REAL
      const values = [-1000.5, -1.5, -0.5, 0.5, 1.5, 1000.5];
      const encoded = values.map(v => encodeValue(v));

      for (let i = 0; i < encoded.length - 1; i++) {
        const cmp = compareBytes(encoded[i], encoded[i + 1]);
        expect(cmp).to.be.lessThan(0, `${values[i]} should sort before ${values[i + 1]}`);
      }
    });

    it('should encode and decode strings with NOCASE', () => {
      const testCases = ['', 'hello', 'Hello World', 'UPPERCASE', 'MixedCase'];

      for (const str of testCases) {
        const encoded = encodeValue(str, { collation: 'NOCASE' });
        const { value } = decodeValue(encoded, 0, { collation: 'NOCASE' });
        // NOCASE stores lowercase
        expect(value).to.equal(str.toLowerCase(), `Failed for "${str}"`);
      }
    });

    it('should encode and decode strings with BINARY', () => {
      const testCases = ['', 'hello', 'Hello World', 'UPPERCASE'];

      for (const str of testCases) {
        const encoded = encodeValue(str, { collation: 'BINARY' });
        const { value } = decodeValue(encoded, 0, { collation: 'BINARY' });
        expect(value).to.equal(str, `Failed for "${str}"`);
      }
    });

    it('should preserve NOCASE string sort order', () => {
      const values = ['apple', 'Banana', 'CHERRY', 'date'];

      // Sort by encoded bytes
      const sorted = [...values].sort((a, b) => {
        const ea = encodeValue(a, { collation: 'NOCASE' });
        const eb = encodeValue(b, { collation: 'NOCASE' });
        return compareBytes(ea, eb);
      });

      expect(sorted).to.deep.equal(['apple', 'Banana', 'CHERRY', 'date']);
    });

    it('should handle strings with null bytes', () => {
      const str = 'hello\x00world';
      const encoded = encodeValue(str, { collation: 'BINARY' });
      const { value } = decodeValue(encoded, 0, { collation: 'BINARY' });
      expect(value).to.equal(str);
    });

    it('should encode and decode blobs', () => {
      const testCases = [
        new Uint8Array([]),
        new Uint8Array([0, 1, 2, 3]),
        new Uint8Array([255, 254, 253]),
        new Uint8Array(1000).fill(42),
      ];

      for (const blob of testCases) {
        const encoded = encodeValue(blob);
        const { value } = decodeValue(encoded);
        expect(value).to.deep.equal(blob);
      }
    });
  });

  describe('encodeCompositeKey / decodeCompositeKey', () => {
    it('should encode and decode composite keys', () => {
      const values = [1n, 'hello', 3.14];
      const encoded = encodeCompositeKey(values, { collation: 'NOCASE' });
      const decoded = decodeCompositeKey(encoded, 3, { collation: 'NOCASE' });

      expect(decoded[0]).to.equal(1n);
      expect(decoded[1]).to.equal('hello'); // lowercase due to NOCASE
      expect(decoded[2]).to.equal(3.14);
    });

    it('should preserve composite key sort order', () => {
      const keys = [
        [1n, 'a'],
        [1n, 'b'],
        [2n, 'a'],
        [2n, 'b'],
      ];

      const encoded = keys.map(k => encodeCompositeKey(k, { collation: 'NOCASE' }));

      for (let i = 0; i < encoded.length - 1; i++) {
        const cmp = compareBytes(encoded[i], encoded[i + 1]);
        expect(cmp).to.be.lessThan(0, `Key ${i} should sort before key ${i + 1}`);
      }
    });
  });
});

/**
 * Compare two byte arrays lexicographically.
 */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

