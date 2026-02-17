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
vi.stubGlobal('document', {
  documentElement: {
    setAttribute: vi.fn(),
    classList: { add: vi.fn(), remove: vi.fn() },
  },
});
vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
  matches: false,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
}));

let uuidCounter = 0;
vi.stubGlobal('crypto', {
  randomUUID: vi.fn(() => `uuid-${++uuidCounter}`),
});

import { useSessionStore } from '../stores/sessionStore.js';

describe('sessionStore', () => {
  beforeEach(() => {
    uuidCounter = 0;
    // Reset to clean state
    useSessionStore.setState({
      tabs: [],
      activeTabId: null,
      queryHistory: [],
      activeResultId: null,
      selectedPanel: 'result',
      syncStatus: { status: 'disconnected' },
      syncEvents: [],
      unsavedChangesDialog: { isOpen: false, tabId: null, fileName: '' },
      loadedPlugins: new Set(),
      pluginErrors: new Map(),
    });
  });

  describe('createTab', () => {
    it('creates a tab with generated name', () => {
      const tabId = useSessionStore.getState().createTab();
      expect(tabId).toBe('uuid-1');
      const { tabs } = useSessionStore.getState();
      expect(tabs).toHaveLength(1);
      expect(tabs[0].id).toBe('uuid-1');
      expect(tabs[0].content).toBe('');
      expect(tabs[0].isActive).toBe(true);
      expect(tabs[0].isDirty).toBe(false);
    });

    it('creates a tab with a custom name', () => {
      const tabId = useSessionStore.getState().createTab('my-query.sql');
      const tab = useSessionStore.getState().tabs.find(t => t.id === tabId);
      expect(tab?.name).toBe('my-query.sql');
    });

    it('deactivates previous tabs when creating new one', () => {
      useSessionStore.getState().createTab('tab1.sql');
      useSessionStore.getState().createTab('tab2.sql');
      const { tabs } = useSessionStore.getState();
      expect(tabs[0].isActive).toBe(false);
      expect(tabs[1].isActive).toBe(true);
    });
  });

  describe('closeTab', () => {
    it('shows unsaved changes dialog for dirty tab', () => {
      const tabId = useSessionStore.getState().createTab('test.sql');
      useSessionStore.getState().updateTabContent(tabId, 'SELECT 1');
      useSessionStore.getState().closeTab(tabId);
      const { unsavedChangesDialog } = useSessionStore.getState();
      expect(unsavedChangesDialog.isOpen).toBe(true);
      expect(unsavedChangesDialog.tabId).toBe(tabId);
    });

    it('closes clean tab immediately', () => {
      const tabId = useSessionStore.getState().createTab('test.sql');
      useSessionStore.getState().closeTab(tabId);
      expect(useSessionStore.getState().tabs).toHaveLength(0);
    });
  });

  describe('forceCloseTab', () => {
    it('closes tab regardless of dirty state', () => {
      const tabId = useSessionStore.getState().createTab('test.sql');
      useSessionStore.getState().updateTabContent(tabId, 'dirty');
      useSessionStore.getState().forceCloseTab(tabId);
      expect(useSessionStore.getState().tabs).toHaveLength(0);
    });

    it('activates previous tab when closing active tab', () => {
      const id1 = useSessionStore.getState().createTab('tab1.sql');
      const id2 = useSessionStore.getState().createTab('tab2.sql');
      useSessionStore.getState().forceCloseTab(id2);
      expect(useSessionStore.getState().activeTabId).toBe(id1);
    });
  });

  describe('setActiveTab', () => {
    it('changes the active tab', () => {
      const id1 = useSessionStore.getState().createTab('tab1.sql');
      useSessionStore.getState().createTab('tab2.sql');
      useSessionStore.getState().setActiveTab(id1);
      const { tabs, activeTabId } = useSessionStore.getState();
      expect(activeTabId).toBe(id1);
      expect(tabs.find(t => t.id === id1)?.isActive).toBe(true);
    });
  });

  describe('updateTabContent', () => {
    it('updates content and marks tab as dirty', () => {
      const tabId = useSessionStore.getState().createTab('test.sql');
      useSessionStore.getState().updateTabContent(tabId, 'SELECT * FROM foo');
      const tab = useSessionStore.getState().tabs.find(t => t.id === tabId);
      expect(tab?.content).toBe('SELECT * FROM foo');
      expect(tab?.isDirty).toBe(true);
    });
  });

  describe('updateTabName', () => {
    it('renames a tab', () => {
      const tabId = useSessionStore.getState().createTab('old.sql');
      useSessionStore.getState().updateTabName(tabId, 'new.sql');
      expect(useSessionStore.getState().tabs.find(t => t.id === tabId)?.name).toBe('new.sql');
    });
  });

  describe('UI state', () => {
    it('setSelectedPanel changes panel', () => {
      useSessionStore.getState().setSelectedPanel('plan');
      expect(useSessionStore.getState().selectedPanel).toBe('plan');
    });

    it('setActiveResultId changes result', () => {
      useSessionStore.getState().setActiveResultId('r1');
      expect(useSessionStore.getState().activeResultId).toBe('r1');
    });

    it('clearHistory empties history', () => {
      useSessionStore.setState({ queryHistory: [{ id: 'q1', sql: 'SELECT 1', executionTime: 10, timestamp: new Date(), planMode: 'estimated' as const }] });
      useSessionStore.getState().clearHistory();
      expect(useSessionStore.getState().queryHistory).toEqual([]);
      expect(useSessionStore.getState().activeResultId).toBeNull();
    });
  });

  describe('unsaved changes dialog', () => {
    it('showUnsavedChangesDialog opens dialog with tab info', () => {
      const tabId = useSessionStore.getState().createTab('test.sql');
      useSessionStore.getState().showUnsavedChangesDialog(tabId);
      const { unsavedChangesDialog } = useSessionStore.getState();
      expect(unsavedChangesDialog.isOpen).toBe(true);
      expect(unsavedChangesDialog.tabId).toBe(tabId);
      expect(unsavedChangesDialog.fileName).toBe('test.sql');
    });

    it('hideUnsavedChangesDialog closes dialog', () => {
      const tabId = useSessionStore.getState().createTab('test.sql');
      useSessionStore.getState().showUnsavedChangesDialog(tabId);
      useSessionStore.getState().hideUnsavedChangesDialog();
      const { unsavedChangesDialog } = useSessionStore.getState();
      expect(unsavedChangesDialog.isOpen).toBe(false);
      expect(unsavedChangesDialog.tabId).toBeNull();
    });
  });

  describe('sync events', () => {
    it('setSyncStatus updates status', () => {
      useSessionStore.getState().setSyncStatus({ status: 'syncing', progress: 50 });
      expect(useSessionStore.getState().syncStatus).toEqual({ status: 'syncing', progress: 50 });
    });

    it('addSyncEvent prepends event', () => {
      const event1 = { type: 'remote-change' as const, timestamp: Date.now(), message: 'pull 1' };
      const event2 = { type: 'local-change' as const, timestamp: Date.now(), message: 'push 1' };
      useSessionStore.getState().addSyncEvent(event1);
      useSessionStore.getState().addSyncEvent(event2);
      const events = useSessionStore.getState().syncEvents;
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual(event2); // most recent first
    });

    it('addSyncEvent caps at 100 events', () => {
      for (let i = 0; i < 110; i++) {
        useSessionStore.getState().addSyncEvent({ type: 'info' as const, timestamp: i, message: `event ${i}` });
      }
      expect(useSessionStore.getState().syncEvents).toHaveLength(100);
    });

    it('clearSyncEvents empties the list', () => {
      useSessionStore.getState().addSyncEvent({ type: 'info' as const, timestamp: 1, message: 'test' });
      useSessionStore.getState().clearSyncEvents();
      expect(useSessionStore.getState().syncEvents).toEqual([]);
    });
  });
});

