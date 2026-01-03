import { expect } from 'chai';
import {
  generateSiteId,
  siteIdToBase64,
  siteIdFromBase64,
  toBase64Url,
  fromBase64Url,
  siteIdEquals,
  serializeSiteIdentity,
  deserializeSiteIdentity,
  type SiteIdentity,
} from '../../src/clock/site.js';

describe('Site ID', () => {
  describe('generateSiteId', () => {
    it('should generate a 16-byte ID', () => {
      const id = generateSiteId();
      expect(id.length).to.equal(16);
    });

    it('should generate unique IDs', () => {
      const id1 = generateSiteId();
      const id2 = generateSiteId();
      expect(siteIdEquals(id1, id2)).to.be.false;
    });

    it('should set UUID v4 version bits', () => {
      const id = generateSiteId();
      // Version 4: byte 6 should have 0x4X pattern
      expect((id[6] & 0xf0) >> 4).to.equal(4);
    });

    it('should set RFC 4122 variant bits', () => {
      const id = generateSiteId();
      // Variant: byte 8 should have 0b10XX pattern
      expect((id[8] & 0xc0) >> 6).to.equal(2);
    });
  });

  describe('base64url conversion', () => {
    it('should round-trip through base64url', () => {
      const original = generateSiteId();
      const base64 = siteIdToBase64(original);
      const restored = siteIdFromBase64(base64);
      expect(siteIdEquals(original, restored)).to.be.true;
    });

    it('should produce 22-character base64url string', () => {
      const id = generateSiteId();
      const base64 = siteIdToBase64(id);
      expect(base64.length).to.equal(22);
      // Base64url uses A-Z, a-z, 0-9, -, _
      expect(/^[A-Za-z0-9_-]+$/.test(base64)).to.be.true;
    });

    it('should throw on invalid base64 length', () => {
      expect(() => siteIdFromBase64('abc')).to.throw('Invalid site ID base64 length');
    });

    it('should handle all byte values correctly', () => {
      // Test with a known pattern
      const testBytes = new Uint8Array([
        0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
        0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
      ]);
      const base64 = siteIdToBase64(testBytes);
      const restored = siteIdFromBase64(base64);
      expect(siteIdEquals(testBytes, restored)).to.be.true;
    });
  });

  describe('generic base64url utilities', () => {
    it('should round-trip arbitrary bytes', () => {
      const original = new Uint8Array([255, 0, 128, 64, 32, 16, 8, 4, 2, 1]);
      const encoded = toBase64Url(original);
      const decoded = fromBase64Url(encoded);
      expect(decoded).to.deep.equal(original);
    });

    it('should handle empty array', () => {
      const empty = new Uint8Array(0);
      const encoded = toBase64Url(empty);
      expect(encoded).to.equal('');
      const decoded = fromBase64Url('');
      expect(decoded.length).to.equal(0);
    });
  });

  describe('siteIdEquals', () => {
    it('should return true for equal IDs', () => {
      const id = generateSiteId();
      const copy = new Uint8Array(id);
      expect(siteIdEquals(id, copy)).to.be.true;
    });

    it('should return false for different IDs', () => {
      const id1 = generateSiteId();
      const id2 = generateSiteId();
      expect(siteIdEquals(id1, id2)).to.be.false;
    });

    it('should return false for different lengths', () => {
      const id1 = new Uint8Array([1, 2, 3]);
      const id2 = new Uint8Array([1, 2, 3, 4]);
      expect(siteIdEquals(id1, id2)).to.be.false;
    });
  });

  describe('SiteIdentity serialization', () => {
    it('should round-trip serialize/deserialize', () => {
      const identity: SiteIdentity = {
        siteId: generateSiteId(),
        createdAt: Date.now(),
      };

      const serialized = serializeSiteIdentity(identity);
      expect(serialized.length).to.equal(24);

      const deserialized = deserializeSiteIdentity(serialized);
      expect(siteIdEquals(deserialized.siteId, identity.siteId)).to.be.true;
      expect(deserialized.createdAt).to.equal(identity.createdAt);
    });

    it('should throw on invalid buffer length', () => {
      expect(() => deserializeSiteIdentity(new Uint8Array(10))).to.throw('Invalid site identity buffer length');
    });
  });
});

