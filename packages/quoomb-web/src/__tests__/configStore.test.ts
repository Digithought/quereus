import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock browser globals before store imports
vi.stubGlobal('localStorage', {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
  length: 0,
  key: vi.fn(() => null),
});

import { useConfigStore } from '../stores/configStore.js';

describe('configStore', () => {
  beforeEach(() => {
    useConfigStore.getState().clearConfig();
  });

  describe('initial state', () => {
    it('starts with null config', () => {
      expect(useConfigStore.getState().config).toBeNull();
    });
  });

  describe('setConfig', () => {
    it('sets config', () => {
      const config = { plugins: [{ source: 'test.js' }], autoload: true };
      useConfigStore.getState().setConfig(config);
      expect(useConfigStore.getState().config).toEqual(config);
    });
  });

  describe('saveConfig', () => {
    it('saves config (same as set)', () => {
      const config = { plugins: [], autoload: false };
      useConfigStore.getState().saveConfig(config);
      expect(useConfigStore.getState().config).toEqual(config);
    });
  });

  describe('clearConfig', () => {
    it('clears config to null', () => {
      useConfigStore.getState().setConfig({ plugins: [] });
      useConfigStore.getState().clearConfig();
      expect(useConfigStore.getState().config).toBeNull();
    });
  });

  describe('exportConfig', () => {
    it('returns default JSON when config is null', () => {
      const exported = useConfigStore.getState().exportConfig();
      const parsed = JSON.parse(exported);
      expect(parsed).toEqual({ plugins: [], autoload: true });
    });

    it('returns serialized config when set', () => {
      const config = { plugins: [{ source: 'plugin.js', config: { key: 'val' } }], autoload: false };
      useConfigStore.getState().setConfig(config);
      const exported = useConfigStore.getState().exportConfig();
      expect(JSON.parse(exported)).toEqual(config);
    });

    it('returns properly formatted JSON', () => {
      useConfigStore.getState().setConfig({ plugins: [] });
      const exported = useConfigStore.getState().exportConfig();
      // Should be pretty-printed with 2-space indent
      expect(exported).toContain('\n');
      expect(exported).toContain('  ');
    });
  });

  describe('importConfig', () => {
    it('imports valid config with plugins and autoload', () => {
      const json = JSON.stringify({ plugins: [{ source: 'x.js' }], autoload: true });
      const result = useConfigStore.getState().importConfig(json);
      expect(result.plugins).toHaveLength(1);
      expect(result.autoload).toBe(true);
    });

    it('imports minimal valid config', () => {
      const result = useConfigStore.getState().importConfig('{}');
      expect(result).toEqual({});
    });

    it('imports config with empty plugins array', () => {
      const result = useConfigStore.getState().importConfig('{"plugins": []}');
      expect(result.plugins).toEqual([]);
    });

    it('throws on invalid JSON', () => {
      expect(() => useConfigStore.getState().importConfig('not json')).toThrow('Invalid config JSON');
    });

    it('throws when plugins is not an array', () => {
      expect(() => useConfigStore.getState().importConfig('{"plugins": "bad"}')).toThrow('plugins must be an array');
    });

    it('throws when autoload is not a boolean', () => {
      expect(() => useConfigStore.getState().importConfig('{"autoload": "yes"}')).toThrow('autoload must be a boolean');
    });

    it('throws for null JSON value', () => {
      expect(() => useConfigStore.getState().importConfig('null')).toThrow('Config must be a JSON object');
    });

    it('does not reject array JSON (validation gap)', () => {
      // Arrays pass typeof === 'object' && !== null check - a known validation gap
      const result = useConfigStore.getState().importConfig('[]');
      expect(result).toBeDefined();
    });
  });
});

