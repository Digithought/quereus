/**
 * Tests for S3 configuration utilities.
 */

import { expect } from 'chai';
import {
  buildBatchKey,
  buildSnapshotKey,
  parseS3ConfigFromEnv,
  type S3StorageConfig,
} from '../src/service/s3-config.js';

describe('S3 Configuration', () => {
  const baseConfig: S3StorageConfig = {
    bucket: 'test-bucket',
    region: 'us-east-1',
  };

  describe('buildBatchKey', () => {
    it('should build key without prefix', () => {
      const key = buildBatchKey(baseConfig, 'org1/db1', 'batch-123', '2026-01-15T10:30:00.000Z');
      expect(key).to.equal('org1/db1/batches/2026-01-15T10-30-00-000Z_batch-123.json');
    });

    it('should include prefix when configured', () => {
      const config: S3StorageConfig = { ...baseConfig, keyPrefix: 'dev/' };
      const key = buildBatchKey(config, 'org1/db1', 'batch-456', '2026-01-15T10:30:00.000Z');
      expect(key).to.equal('dev/org1/db1/batches/2026-01-15T10-30-00-000Z_batch-456.json');
    });

    it('should sanitize timestamp colons and dots', () => {
      const key = buildBatchKey(baseConfig, 'db', 'id', '2026-01-15T10:30:45.123Z');
      expect(key).to.not.include(':');
      // dots in timestamp should be replaced
      expect(key).to.include('2026-01-15T10-30-45-123Z');
    });
  });

  describe('buildSnapshotKey', () => {
    it('should build snapshot key without prefix', () => {
      const key = buildSnapshotKey(baseConfig, 'org1/db1', 'snap-789', '2026-02-01T12:00:00.000Z');
      expect(key).to.equal('org1/db1/snapshots/2026-02-01T12-00-00-000Z_snap-789.json');
    });

    it('should include prefix when configured', () => {
      const config: S3StorageConfig = { ...baseConfig, keyPrefix: 'prod/' };
      const key = buildSnapshotKey(config, 'org1/db1', 'snap-1', '2026-02-01T12:00:00.000Z');
      expect(key).to.equal('prod/org1/db1/snapshots/2026-02-01T12-00-00-000Z_snap-1.json');
    });
  });

  describe('parseS3ConfigFromEnv', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('should return undefined when S3_BUCKET not set', () => {
      delete process.env.S3_BUCKET;
      expect(parseS3ConfigFromEnv()).to.be.undefined;
    });

    it('should parse minimal config with just bucket', () => {
      process.env.S3_BUCKET = 'my-bucket';
      delete process.env.S3_REGION;
      delete process.env.S3_ENDPOINT;
      delete process.env.S3_ACCESS_KEY_ID;
      delete process.env.S3_SECRET_ACCESS_KEY;
      delete process.env.S3_FORCE_PATH_STYLE;
      delete process.env.S3_KEY_PREFIX;

      const config = parseS3ConfigFromEnv();
      expect(config).to.not.be.undefined;
      expect(config!.bucket).to.equal('my-bucket');
      expect(config!.region).to.equal('us-east-1'); // default
    });

    it('should parse region', () => {
      process.env.S3_BUCKET = 'my-bucket';
      process.env.S3_REGION = 'eu-west-1';
      const config = parseS3ConfigFromEnv()!;
      expect(config.region).to.equal('eu-west-1');
    });

    it('should parse endpoint for MinIO', () => {
      process.env.S3_BUCKET = 'my-bucket';
      process.env.S3_ENDPOINT = 'http://localhost:9000';
      const config = parseS3ConfigFromEnv()!;
      expect(config.endpoint).to.equal('http://localhost:9000');
    });

    it('should parse credentials', () => {
      process.env.S3_BUCKET = 'my-bucket';
      process.env.S3_ACCESS_KEY_ID = 'AKIAEXAMPLE';
      process.env.S3_SECRET_ACCESS_KEY = 'secret123';
      const config = parseS3ConfigFromEnv()!;
      expect(config.credentials).to.deep.equal({
        accessKeyId: 'AKIAEXAMPLE',
        secretAccessKey: 'secret123',
      });
    });

    it('should not set credentials if only one part provided', () => {
      process.env.S3_BUCKET = 'my-bucket';
      process.env.S3_ACCESS_KEY_ID = 'AKIAEXAMPLE';
      delete process.env.S3_SECRET_ACCESS_KEY;
      const config = parseS3ConfigFromEnv()!;
      expect(config.credentials).to.be.undefined;
    });

    it('should parse forcePathStyle', () => {
      process.env.S3_BUCKET = 'my-bucket';
      process.env.S3_FORCE_PATH_STYLE = 'true';
      const config = parseS3ConfigFromEnv()!;
      expect(config.forcePathStyle).to.be.true;
    });

    it('should parse key prefix', () => {
      process.env.S3_BUCKET = 'my-bucket';
      process.env.S3_KEY_PREFIX = 'sync-data/';
      const config = parseS3ConfigFromEnv()!;
      expect(config.keyPrefix).to.equal('sync-data/');
    });
  });
});

