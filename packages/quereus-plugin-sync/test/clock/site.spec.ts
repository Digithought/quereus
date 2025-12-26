import { expect } from 'chai';
import {
  generateSiteId,
  siteIdToHex,
  siteIdFromHex,
  siteIdToUUID,
  siteIdFromUUID,
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

  describe('hex conversion', () => {
    it('should round-trip through hex', () => {
      const original = generateSiteId();
      const hex = siteIdToHex(original);
      const restored = siteIdFromHex(hex);
      expect(siteIdEquals(original, restored)).to.be.true;
    });

    it('should produce 32-character hex string', () => {
      const id = generateSiteId();
      const hex = siteIdToHex(id);
      expect(hex.length).to.equal(32);
      expect(/^[0-9a-f]+$/.test(hex)).to.be.true;
    });

    it('should throw on invalid hex length', () => {
      expect(() => siteIdFromHex('abc')).to.throw('Invalid site ID hex length');
    });
  });

  describe('UUID conversion', () => {
    it('should round-trip through UUID', () => {
      const original = generateSiteId();
      const uuid = siteIdToUUID(original);
      const restored = siteIdFromUUID(uuid);
      expect(siteIdEquals(original, restored)).to.be.true;
    });

    it('should produce valid UUID format', () => {
      const id = generateSiteId();
      const uuid = siteIdToUUID(id);
      // UUID format: 8-4-4-4-12
      expect(uuid).to.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
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

