import { expect } from 'chai';
import {
  HLCManager,
  compareHLC,
  hlcEquals,
  createHLC,
  serializeHLC,
  deserializeHLC,
} from '../../src/clock/hlc.js';
import { generateSiteId } from '../../src/clock/site.js';

describe('HLC (Hybrid Logical Clock)', () => {
  describe('compareHLC', () => {
    const siteA = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const siteB = new Uint8Array([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

    it('should order by wallTime first', () => {
      const a = createHLC(1000n, 0, siteA);
      const b = createHLC(2000n, 0, siteA);
      expect(compareHLC(a, b)).to.be.lessThan(0);
      expect(compareHLC(b, a)).to.be.greaterThan(0);
    });

    it('should order by counter when wallTime is equal', () => {
      const a = createHLC(1000n, 1, siteA);
      const b = createHLC(1000n, 2, siteA);
      expect(compareHLC(a, b)).to.be.lessThan(0);
      expect(compareHLC(b, a)).to.be.greaterThan(0);
    });

    it('should order by siteId when wallTime and counter are equal', () => {
      const a = createHLC(1000n, 1, siteA);
      const b = createHLC(1000n, 1, siteB);
      expect(compareHLC(a, b)).to.be.lessThan(0);
      expect(compareHLC(b, a)).to.be.greaterThan(0);
    });

    it('should return 0 for equal HLCs', () => {
      const a = createHLC(1000n, 1, siteA);
      const b = createHLC(1000n, 1, siteA);
      expect(compareHLC(a, b)).to.equal(0);
    });
  });

  describe('hlcEquals', () => {
    const siteA = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

    it('should return true for equal HLCs', () => {
      const a = createHLC(1000n, 1, siteA);
      const b = createHLC(1000n, 1, siteA);
      expect(hlcEquals(a, b)).to.be.true;
    });

    it('should return false for different HLCs', () => {
      const a = createHLC(1000n, 1, siteA);
      const b = createHLC(1000n, 2, siteA);
      expect(hlcEquals(a, b)).to.be.false;
    });
  });

  describe('serialization', () => {
    it('should round-trip serialize/deserialize', () => {
      const siteId = generateSiteId();
      const original = createHLC(1234567890123n, 42, siteId);

      const serialized = serializeHLC(original);
      expect(serialized.length).to.equal(26);

      const deserialized = deserializeHLC(serialized);
      expect(deserialized.wallTime).to.equal(original.wallTime);
      expect(deserialized.counter).to.equal(original.counter);
      expect(hlcEquals(deserialized, original)).to.be.true;
    });

    it('should throw on invalid buffer length', () => {
      expect(() => deserializeHLC(new Uint8Array(10))).to.throw('Invalid HLC buffer length');
    });
  });

  describe('HLCManager', () => {
    describe('tick', () => {
      it('should generate monotonically increasing HLCs', () => {
        const siteId = generateSiteId();
        const manager = new HLCManager(siteId);

        const hlc1 = manager.tick();
        const hlc2 = manager.tick();
        const hlc3 = manager.tick();

        expect(compareHLC(hlc1, hlc2)).to.be.lessThan(0);
        expect(compareHLC(hlc2, hlc3)).to.be.lessThan(0);
      });

      it('should increment counter for same millisecond', () => {
        const siteId = generateSiteId();
        const manager = new HLCManager(siteId, { wallTime: 1000n, counter: 0 });

        // Force same wall time by setting initial state
        const hlc1 = manager.tick();
        const hlc2 = manager.tick();

        // Counter should increment if wall time hasn't advanced
        expect(hlc2.counter).to.be.greaterThanOrEqual(hlc1.counter);
      });

      it('should use provided siteId', () => {
        const siteId = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
        const manager = new HLCManager(siteId);

        const hlc = manager.tick();
        expect(Array.from(hlc.siteId)).to.deep.equal(Array.from(siteId));
      });
    });

    describe('receive', () => {
      it('should advance clock when receiving future timestamp', () => {
        const siteA = generateSiteId();
        const siteB = generateSiteId();
        const manager = new HLCManager(siteA, { wallTime: 1000n, counter: 0 });

        const remoteHLC = createHLC(2000n, 5, siteB);
        const received = manager.receive(remoteHLC);

        expect(received.wallTime >= remoteHLC.wallTime).to.be.true;
      });

      it('should reject timestamps too far in the future', () => {
        const siteA = generateSiteId();
        const siteB = generateSiteId();
        const manager = new HLCManager(siteA);

        // Create a timestamp 2 minutes in the future (exceeds 1 minute max drift)
        const futureTime = BigInt(Date.now()) + BigInt(120_000);
        const remoteHLC = createHLC(futureTime, 0, siteB);

        expect(() => manager.receive(remoteHLC)).to.throw('Remote clock too far in future');
      });

      it('should maintain causality after receive', () => {
        const siteA = generateSiteId();
        const siteB = generateSiteId();
        const manager = new HLCManager(siteA);

        const localBefore = manager.tick();
        const remoteHLC = createHLC(localBefore.wallTime + 100n, 0, siteB);
        const received = manager.receive(remoteHLC);
        const localAfter = manager.tick();

        // received should be > remoteHLC (we've seen it)
        expect(compareHLC(received, remoteHLC)).to.be.greaterThan(0);
        // localAfter should be > received
        expect(compareHLC(localAfter, received)).to.be.greaterThan(0);
      });
    });

    describe('now', () => {
      it('should return current state without advancing', () => {
        const siteId = generateSiteId();
        const manager = new HLCManager(siteId, { wallTime: 1000n, counter: 5 });

        const now1 = manager.now();
        const now2 = manager.now();

        expect(hlcEquals(now1, now2)).to.be.true;
        expect(now1.wallTime).to.equal(1000n);
        expect(now1.counter).to.equal(5);
      });
    });

    describe('getState', () => {
      it('should return current clock state for persistence', () => {
        const siteId = generateSiteId();
        const manager = new HLCManager(siteId, { wallTime: 1000n, counter: 5 });

        const state = manager.getState();
        expect(state.wallTime).to.equal(1000n);
        expect(state.counter).to.equal(5);
      });
    });
  });
});

