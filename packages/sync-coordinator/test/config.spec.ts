/**
 * Tests for configuration loading.
 */

import { expect } from 'chai';
import { loadConfig, loadEnvConfig, DEFAULT_CONFIG } from '../src/config/index.js';

describe('Configuration', () => {
  describe('DEFAULT_CONFIG', () => {
    it('should have sensible defaults', () => {
      expect(DEFAULT_CONFIG.host).to.equal('0.0.0.0');
      expect(DEFAULT_CONFIG.port).to.equal(3000);
      expect(DEFAULT_CONFIG.basePath).to.equal('/sync');
      expect(DEFAULT_CONFIG.auth.mode).to.equal('none');
      expect(DEFAULT_CONFIG.cors.origin).to.equal(true);
    });
  });

  describe('loadEnvConfig', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      // Restore original environment
      process.env = { ...originalEnv };
    });

    it('should load host from SYNC_HOST', () => {
      process.env.SYNC_HOST = 'localhost';
      const config = loadEnvConfig();
      expect(config.host).to.equal('localhost');
    });

    it('should load port from SYNC_PORT', () => {
      process.env.SYNC_PORT = '8080';
      const config = loadEnvConfig();
      expect(config.port).to.equal(8080);
    });

    it('should load CORS origin as boolean true', () => {
      process.env.SYNC_CORS_ORIGIN = 'true';
      const config = loadEnvConfig();
      expect(config.cors?.origin).to.equal(true);
    });

    it('should load CORS origin as boolean false', () => {
      process.env.SYNC_CORS_ORIGIN = 'false';
      const config = loadEnvConfig();
      expect(config.cors?.origin).to.equal(false);
    });

    it('should load CORS origin as array', () => {
      process.env.SYNC_CORS_ORIGIN = 'http://localhost:3000, http://example.com';
      const config = loadEnvConfig();
      expect(config.cors?.origin).to.deep.equal(['http://localhost:3000', 'http://example.com']);
    });

    it('should load auth tokens', () => {
      process.env.SYNC_AUTH_TOKENS = 'token1, token2, token3';
      const config = loadEnvConfig();
      expect(config.auth?.tokens).to.deep.equal(['token1', 'token2', 'token3']);
    });
  });

  describe('loadConfig', () => {
    it('should return defaults when no overrides', () => {
      const config = loadConfig();
      expect(config.host).to.equal(DEFAULT_CONFIG.host);
      expect(config.port).to.equal(DEFAULT_CONFIG.port);
    });

    it('should apply overrides', () => {
      const config = loadConfig({
        overrides: {
          host: '127.0.0.1',
          port: 9000,
        },
      });
      expect(config.host).to.equal('127.0.0.1');
      expect(config.port).to.equal(9000);
    });

    it('should deep merge nested config', () => {
      const config = loadConfig({
        overrides: {
          cors: { credentials: false },
        },
      });
      // Should keep default origin but override credentials
      expect(config.cors.origin).to.equal(true);
      expect(config.cors.credentials).to.equal(false);
    });
  });
});

