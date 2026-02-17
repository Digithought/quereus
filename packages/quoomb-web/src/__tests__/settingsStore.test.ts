import { vi, describe, it, expect, beforeEach } from 'vitest';

const mockMatchMedia = vi.fn().mockReturnValue({
  matches: false,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
});

// Mock browser globals before store imports
vi.stubGlobal('localStorage', {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
  length: 0,
  key: vi.fn(() => null),
});
vi.stubGlobal('document', {
  documentElement: {
    setAttribute: vi.fn(),
    classList: { add: vi.fn(), remove: vi.fn() },
  },
});
vi.stubGlobal('matchMedia', mockMatchMedia);
vi.stubGlobal('window', {
  matchMedia: mockMatchMedia,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
});

import { useSettingsStore } from '../stores/settingsStore.js';

describe('settingsStore', () => {
  beforeEach(() => {
    // Reset store to defaults before each test
    useSettingsStore.getState().resetToDefaults();
  });

  describe('default values', () => {
    it('has correct default theme', () => {
      expect(useSettingsStore.getState().theme).toBe('auto');
    });
    it('has correct default font size', () => {
      expect(useSettingsStore.getState().fontSize).toBe(14);
    });
    it('has correct default storage module', () => {
      expect(useSettingsStore.getState().storageModule).toBe('memory');
    });
    it('has empty plugins array', () => {
      expect(useSettingsStore.getState().plugins).toEqual([]);
    });
    it('has correct default sync settings', () => {
      const state = useSettingsStore.getState();
      expect(state.syncUrl).toBe('ws://localhost:8080/sync/ws');
      expect(state.syncDatabaseId).toBe('local-s1');
    });
  });

  describe('setTheme', () => {
    it('sets theme to light', () => {
      useSettingsStore.getState().setTheme('light');
      expect(useSettingsStore.getState().theme).toBe('light');
    });
    it('sets theme to dark', () => {
      useSettingsStore.getState().setTheme('dark');
      expect(useSettingsStore.getState().theme).toBe('dark');
    });
    it('sets theme to auto', () => {
      useSettingsStore.getState().setTheme('dark');
      useSettingsStore.getState().setTheme('auto');
      expect(useSettingsStore.getState().theme).toBe('auto');
    });
  });

  describe('setFontSize', () => {
    it('sets valid font size', () => {
      useSettingsStore.getState().setFontSize(18);
      expect(useSettingsStore.getState().fontSize).toBe(18);
    });
    it('clamps font size below minimum to 8', () => {
      useSettingsStore.getState().setFontSize(2);
      expect(useSettingsStore.getState().fontSize).toBe(8);
    });
    it('clamps font size above maximum to 32', () => {
      useSettingsStore.getState().setFontSize(100);
      expect(useSettingsStore.getState().fontSize).toBe(32);
    });
  });

  describe('setAutoSaveDelay', () => {
    it('sets valid delay', () => {
      useSettingsStore.getState().setAutoSaveDelay(3000);
      expect(useSettingsStore.getState().autoSaveDelay).toBe(3000);
    });
    it('clamps delay below minimum to 500', () => {
      useSettingsStore.getState().setAutoSaveDelay(100);
      expect(useSettingsStore.getState().autoSaveDelay).toBe(500);
    });
    it('clamps delay above maximum to 10000', () => {
      useSettingsStore.getState().setAutoSaveDelay(50000);
      expect(useSettingsStore.getState().autoSaveDelay).toBe(10000);
    });
  });

  describe('setMaxHistoryItems', () => {
    it('sets valid max', () => {
      useSettingsStore.getState().setMaxHistoryItems(200);
      expect(useSettingsStore.getState().maxHistoryItems).toBe(200);
    });
    it('clamps below minimum to 10', () => {
      useSettingsStore.getState().setMaxHistoryItems(1);
      expect(useSettingsStore.getState().maxHistoryItems).toBe(10);
    });
    it('clamps above maximum to 1000', () => {
      useSettingsStore.getState().setMaxHistoryItems(5000);
      expect(useSettingsStore.getState().maxHistoryItems).toBe(1000);
    });
  });

  describe('plugin CRUD', () => {
    const testPlugin = { id: 'p1', url: 'https://example.com/plugin.js', enabled: true, config: {} };

    it('adds a plugin', () => {
      useSettingsStore.getState().addPlugin(testPlugin);
      expect(useSettingsStore.getState().plugins).toHaveLength(1);
      expect(useSettingsStore.getState().plugins[0].id).toBe('p1');
    });
    it('updates a plugin', () => {
      useSettingsStore.getState().addPlugin(testPlugin);
      useSettingsStore.getState().updatePlugin('p1', { enabled: false });
      expect(useSettingsStore.getState().plugins[0].enabled).toBe(false);
    });
    it('removes a plugin', () => {
      useSettingsStore.getState().addPlugin(testPlugin);
      useSettingsStore.getState().removePlugin('p1');
      expect(useSettingsStore.getState().plugins).toHaveLength(0);
    });
    it('sets plugins list', () => {
      const plugins = [testPlugin, { ...testPlugin, id: 'p2', url: 'https://example.com/p2.js' }];
      useSettingsStore.getState().setPlugins(plugins);
      expect(useSettingsStore.getState().plugins).toHaveLength(2);
    });
  });

  describe('storage and sync settings', () => {
    it('sets storage module', () => {
      useSettingsStore.getState().setStorageModule('store');
      expect(useSettingsStore.getState().storageModule).toBe('store');
    });
    it('sets sync URL', () => {
      useSettingsStore.getState().setSyncUrl('ws://remote:9090/sync');
      expect(useSettingsStore.getState().syncUrl).toBe('ws://remote:9090/sync');
    });
    it('sets sync database ID', () => {
      useSettingsStore.getState().setSyncDatabaseId('myaccount-s2');
      expect(useSettingsStore.getState().syncDatabaseId).toBe('myaccount-s2');
    });
  });

  describe('resetToDefaults', () => {
    it('resets all settings to defaults', () => {
      useSettingsStore.getState().setTheme('dark');
      useSettingsStore.getState().setFontSize(24);
      useSettingsStore.getState().setStorageModule('sync');
      useSettingsStore.getState().addPlugin({ id: 'p1', url: 'x', enabled: true, config: {} });
      useSettingsStore.getState().resetToDefaults();
      const state = useSettingsStore.getState();
      expect(state.theme).toBe('auto');
      expect(state.fontSize).toBe(14);
      expect(state.storageModule).toBe('memory');
      expect(state.plugins).toEqual([]);
    });
  });
});

