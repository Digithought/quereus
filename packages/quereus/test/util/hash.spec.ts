import { expect } from 'chai';
import { fnv1aHash, toBase64Url } from '../../src/util/hash.js';

describe('Hash Utilities', () => {
	describe('fnv1aHash', () => {
		it('should return an 8-byte Uint8Array', () => {
			const result = fnv1aHash('test');
			expect(result).to.be.instanceOf(Uint8Array);
			expect(result.length).to.equal(8);
		});

		it('should produce consistent hashes for the same input', () => {
			const hash1 = fnv1aHash('hello world');
			const hash2 = fnv1aHash('hello world');
			expect(Array.from(hash1)).to.deep.equal(Array.from(hash2));
		});

		it('should produce different hashes for different inputs', () => {
			const hash1 = fnv1aHash('hello');
			const hash2 = fnv1aHash('world');
			expect(Array.from(hash1)).to.not.deep.equal(Array.from(hash2));
		});

		it('should handle empty string', () => {
			const result = fnv1aHash('');
			expect(result).to.be.instanceOf(Uint8Array);
			expect(result.length).to.equal(8);
			// Empty string should produce the FNV offset basis
			expect(Array.from(result)).to.deep.equal([0xcb, 0xf2, 0x9c, 0xe4, 0x84, 0x22, 0x23, 0x25]);
		});

		it('should handle ASCII characters', () => {
			const result = fnv1aHash('abc123');
			expect(result).to.be.instanceOf(Uint8Array);
			expect(result.length).to.equal(8);
		});

		it('should handle Unicode characters', () => {
			const result = fnv1aHash('Hello 世界 🌍');
			expect(result).to.be.instanceOf(Uint8Array);
			expect(result.length).to.equal(8);
		});

		it('should produce different hashes for similar strings', () => {
			const hash1 = fnv1aHash('test');
			const hash2 = fnv1aHash('Test');
			const hash3 = fnv1aHash('test ');
			expect(Array.from(hash1)).to.not.deep.equal(Array.from(hash2));
			expect(Array.from(hash1)).to.not.deep.equal(Array.from(hash3));
		});

		it('should handle long strings', () => {
			const longString = 'a'.repeat(10000);
			const result = fnv1aHash(longString);
			expect(result).to.be.instanceOf(Uint8Array);
			expect(result.length).to.equal(8);
		});

		it('should produce well-distributed hashes', () => {
			// Test that small changes produce different hashes
			const hashes = new Set<string>();
			for (let i = 0; i < 100; i++) {
				const hash = fnv1aHash(`test${i}`);
				hashes.add(Array.from(hash).join(','));
			}
			// All hashes should be unique
			expect(hashes.size).to.equal(100);
		});
	});

	describe('toBase64Url', () => {
		it('should encode empty array', () => {
			const result = toBase64Url(new Uint8Array([]));
			expect(result).to.equal('');
		});

		it('should encode single byte', () => {
			const result = toBase64Url(new Uint8Array([0]));
			expect(result).to.equal('AA');
		});

		it('should encode two bytes', () => {
			const result = toBase64Url(new Uint8Array([0, 0]));
			expect(result).to.equal('AAA');
		});

		it('should encode three bytes (full triplet)', () => {
			const result = toBase64Url(new Uint8Array([0, 0, 0]));
			expect(result).to.equal('AAAA');
		});

		it('should use URL-safe characters', () => {
			// Test that it uses - and _ instead of + and /
			const result = toBase64Url(new Uint8Array([0xff, 0xff, 0xff]));
			expect(result).to.equal('____');
			expect(result).to.not.include('+');
			expect(result).to.not.include('/');
		});

		it('should not include padding', () => {
			const result1 = toBase64Url(new Uint8Array([1]));
			const result2 = toBase64Url(new Uint8Array([1, 2]));
			expect(result1).to.not.include('=');
			expect(result2).to.not.include('=');
		});

		it('should encode 8-byte hash correctly', () => {
			const bytes = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]);
			const result = toBase64Url(bytes);
			expect(result).to.be.a('string');
			expect(result.length).to.equal(11); // 8 bytes = 11 base64url chars (no padding)
		});

		it('should produce consistent output', () => {
			const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
			const result1 = toBase64Url(bytes);
			const result2 = toBase64Url(bytes);
			expect(result1).to.equal(result2);
		});

		it('should only use valid base64url characters', () => {
			const bytes = new Uint8Array(256);
			for (let i = 0; i < 256; i++) {
				bytes[i] = i;
			}
			const result = toBase64Url(bytes);
			const validChars = /^[A-Za-z0-9_-]*$/;
			expect(result).to.match(validChars);
		});
	});

	describe('fnv1aHash + toBase64Url integration', () => {
		it('should produce 11-character base64url string for any input', () => {
			const inputs = ['', 'a', 'hello', 'Hello World!', '世界', 'a'.repeat(1000)];
			for (const input of inputs) {
				const hash = fnv1aHash(input);
				const encoded = toBase64Url(hash);
				expect(encoded).to.be.a('string');
				expect(encoded.length).to.equal(11);
				expect(encoded).to.match(/^[A-Za-z0-9_-]{11}$/);
			}
		});

		it('should produce different encoded hashes for different inputs', () => {
			const hash1 = toBase64Url(fnv1aHash('input1'));
			const hash2 = toBase64Url(fnv1aHash('input2'));
			expect(hash1).to.not.equal(hash2);
		});
	});
});

