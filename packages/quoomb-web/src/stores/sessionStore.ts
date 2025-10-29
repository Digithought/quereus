import { create } from 'zustand';
import { subscribeWithSelector, persist } from 'zustand/middleware';
import type { SqlValue } from '@quereus/quereus';
import { QuereusWorkerAPI, PlanGraph, PluginRecord, PluginManifest } from '../worker/types.js';
import { validatePluginUrl, ErrorInfo, unwrapError, interpolateConfigEnvVars } from '@quereus/quereus';
import { useSettingsStore } from './settingsStore.js';
import { useConfigStore } from './configStore.js';
import * as Comlink from 'comlink';

export interface QueryResult {
  id: string;
  sql: string;
  results?: Record<string, SqlValue>[];
  error?: string;
  errorChain?: ErrorInfo[];
  executionTime: number;
  timestamp: Date;
  queryPlan?: Record<string, SqlValue>[];
  program?: Record<string, SqlValue>[];
  trace?: Record<string, SqlValue>[];
  rowTrace?: Record<string, SqlValue>[];
  planGraph?: PlanGraph;
  planMode: 'estimated' | 'actual';
  selectedNodeId?: string;
  // Selection tracking for error navigation
  selectionInfo?: {
    isSelection: boolean;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  };
}

export interface Tab {
  id: string;
  name: string;
  content: string;
  isActive: boolean;
  isDirty: boolean;
}

export interface SessionState {
  // Connection state
  isConnected: boolean;
  isConnecting: boolean;
  connectionError: string | null;
  worker: Worker | null;
  api: Comlink.Remote<QuereusWorkerAPI> | null;

  // Session data
  sessionId: string | null;
  tabs: Tab[];
  activeTabId: string | null;

  // Query execution
  isExecuting: boolean;
  currentQuery: string | null;
  queryHistory: QueryResult[];

  // Results display
  activeResultId: string | null;
  selectedPanel: 'result' | 'plan' | 'graph' | 'program' | 'trace' | 'messages';

  // Plugin state
  loadedPlugins: Set<string>;
  pluginErrors: Map<string, string>; // plugin id -> error message

  // Unsaved changes dialog
  unsavedChangesDialog: {
    isOpen: boolean;
    tabId: string | null;
    fileName: string;
  };

  // Actions
  initializeSession: () => Promise<void>;
  executeSQL: (sql: string, selectionInfo?: { isSelection: boolean; startLine: number; startColumn: number; endLine: number; endColumn: number; }) => Promise<void>;
  fetchQueryPlan: (sql: string) => Promise<void>;
  fetchProgram: (sql: string) => Promise<void>;
  fetchTrace: (sql: string) => Promise<void>;
  fetchRowTrace: (sql: string) => Promise<void>;
  fetchPlanGraph: (sql: string, withActual?: boolean) => Promise<void>;
  createTab: (name?: string) => string;
  closeTab: (tabId: string) => void;
  forceCloseTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  updateTabContent: (tabId: string, content: string) => void;
  updateTabName: (tabId: string, name: string) => void;
  setSelectedPanel: (panel: 'result' | 'plan' | 'graph' | 'program' | 'trace' | 'messages') => void;
  setActiveResultId: (resultId: string | null) => void;
  setSelectedNodeId: (nodeId: string | undefined) => void;
  setPlanMode: (mode: 'estimated' | 'actual') => void;
  exportResultsAsCSV: () => void;
  exportResultsAsJSON: () => void;
  saveCurrentTabAsFile: () => Promise<void>;
  saveTabAsFile: (tabId: string) => Promise<void>;
  loadSQLFile: () => Promise<void>;
  showUnsavedChangesDialog: (tabId: string) => void;
  hideUnsavedChangesDialog: () => void;
  clearHistory: () => void;
  disconnect: () => Promise<void>;

  // Plugin management
  installPlugin: (url: string) => Promise<void>;
  togglePlugin: (id: string, enabled: boolean) => Promise<void>;
  updatePluginConfig: (id: string, config: Record<string, SqlValue>) => Promise<void>;
  reloadPlugin: (id: string) => Promise<void>;
  getPluginError: (id: string) => string | undefined;
  clearPluginError: (id: string) => void;
  loadEnabledPlugins: () => Promise<void>;
}

export const useSessionStore = create<SessionState>()(
  persist(
    subscribeWithSelector(
      (set, get) => ({
        // Initial state
        isConnected: false,
        isConnecting: false,
        connectionError: null,
        worker: null,
        api: null,

        sessionId: null,
        tabs: [],
        activeTabId: null,

        isExecuting: false,
        currentQuery: null,
        queryHistory: [],

        activeResultId: null,
        selectedPanel: 'result',

        // Plugin state
        loadedPlugins: new Set(),
        pluginErrors: new Map(),

        // Unsaved changes dialog
        unsavedChangesDialog: {
          isOpen: false,
          tabId: null,
          fileName: '',
        },

        // Actions
        initializeSession: async () => {
          set(() => ({
            isConnecting: true,
            connectionError: null,
          }));

          try {
            // Create and setup Web Worker
            const worker = new Worker(
              new URL('../worker/quereus.worker.ts', import.meta.url),
              { type: 'module' }
            );

            const api = Comlink.wrap<QuereusWorkerAPI>(worker);

            // Initialize the Quereus session in the worker
            await api.initialize();

            const sessionId = crypto.randomUUID();

            const initialTab: Tab = {
              id: crypto.randomUUID(),
              name: 'scratch.sql',
              content: 'SELECT \'Hello, Quoomb!\' as message;',
              isActive: true,
              isDirty: false,
            };

            set((state) => {
              // If no tabs exist (fresh start), create initial tab
              // If tabs exist (restored from localStorage), use them
              if (state.tabs.length === 0) {
                return {
                  ...state,
                  worker,
                  api,
                  sessionId,
                  isConnected: true,
                  isConnecting: false,
                  tabs: [initialTab],
                  activeTabId: initialTab.id,
                };
              } else {
                // Ensure at least one tab is marked as active
                const hasActiveTab = state.tabs.some(tab => tab.isActive);
                const updatedTabs = hasActiveTab
                  ? state.tabs
                  : state.tabs.map((tab, index) => ({
                      ...tab,
                      isActive: index === 0
                    }));

                return {
                  ...state,
                  worker,
                  api,
                  sessionId,
                  isConnected: true,
                  isConnecting: false,
                  tabs: updatedTabs,
                  activeTabId: state.activeTabId || (updatedTabs.length > 0 ? updatedTabs[0].id : null),
                };
              }
            });

            // Load enabled plugins after successful initialization
            await get().loadEnabledPlugins();
          } catch (error) {
            set(() => ({
              isConnecting: false,
              connectionError: error instanceof Error ? error.message : 'Failed to initialize session',
            }));
          }
        },

        executeSQL: async (sql: string, selectionInfo?: { isSelection: boolean; startLine: number; startColumn: number; endLine: number; endColumn: number; }) => {
          const { api, isConnected } = get();

          if (!api || !isConnected) {
            throw new Error('Not connected to database');
          }

          set((state) => ({
            ...state,
            isExecuting: true,
            currentQuery: sql,
          }));

          const startTime = Date.now();
          const resultId = crypto.randomUUID();

          try {
            const results = await api.executeQuery(sql);
            const executionTime = Date.now() - startTime;

            const queryResult: QueryResult = {
              id: resultId,
              sql,
              results,
              executionTime,
              timestamp: new Date(),
              planMode: 'estimated',
              selectionInfo,
            };

            set((state) => ({
              ...state,
              queryHistory: [queryResult, ...state.queryHistory],
              activeResultId: resultId,
              isExecuting: false,
              currentQuery: null,
            }));
          } catch (error) {
            const executionTime = Date.now() - startTime;
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';

            // Unwrap error chain for enhanced error information
            const errorChain = error instanceof Error ? unwrapError(error) : [];

            const queryResult: QueryResult = {
              id: resultId,
              sql,
              error: errorMessage,
              errorChain,
              executionTime,
              timestamp: new Date(),
              planMode: 'estimated',
              selectionInfo,
            };

            set((state) => ({
              ...state,
              queryHistory: [queryResult, ...state.queryHistory],
              activeResultId: resultId,
              isExecuting: false,
              currentQuery: null,
            }));
          }
        },

        fetchQueryPlan: async (sql: string) => {
          const { api, isConnected, queryHistory, activeResultId } = get();

          if (!api || !isConnected) {
            throw new Error('Not connected to database');
          }

          try {
            const plan = await api.explainQuery(sql);

            // Update the active result with the query plan
            if (activeResultId) {
              set((state) => ({
                ...state,
                queryHistory: state.queryHistory.map(result =>
                  result.id === activeResultId
                    ? { ...result, queryPlan: plan }
                    : result
                ),
              }));
            }
          } catch (error) {
            console.error('Failed to fetch query plan:', error);
            throw error;
          }
        },

        fetchProgram: async (sql: string) => {
          const { api, isConnected, activeResultId } = get();

          if (!api || !isConnected) {
            throw new Error('Not connected to database');
          }

          try {
            const program = await api.explainProgram(sql);

            // Update the active result with the query program
            if (activeResultId) {
              set((state) => ({
                ...state,
                queryHistory: state.queryHistory.map(result =>
                  result.id === activeResultId
                    ? { ...result, program: program }
                    : result
                ),
              }));
            }
          } catch (error) {
            console.error('Failed to fetch query program:', error);
            throw error;
          }
        },

        fetchTrace: async (sql: string) => {
          const { api, isConnected, activeResultId } = get();

          if (!api || !isConnected) {
            throw new Error('Not connected to database');
          }

          try {
            const trace = await api.executionTrace(sql);

            // Update the active result with the query trace
            if (activeResultId) {
              set((state) => ({
                ...state,
                queryHistory: state.queryHistory.map(result =>
                  result.id === activeResultId
                    ? { ...result, trace: trace }
                    : result
                ),
              }));
            }
          } catch (error) {
            console.error('Failed to fetch query trace:', error);
            throw error;
          }
        },

        fetchRowTrace: async (sql: string) => {
          const { api, isConnected, activeResultId } = get();

          if (!api || !isConnected) {
            throw new Error('Not connected to database');
          }

          try {
            const rowTrace = await api.rowTrace(sql);

            // Update the active result with the query row trace
            if (activeResultId) {
              set((state) => ({
                ...state,
                queryHistory: state.queryHistory.map(result =>
                  result.id === activeResultId
                    ? { ...result, rowTrace: rowTrace }
                    : result
                ),
              }));
            }
          } catch (error) {
            console.error('Failed to fetch query row trace:', error);
            throw error;
          }
        },

        fetchPlanGraph: async (sql: string, withActual?: boolean) => {
          const { api, isConnected, activeResultId } = get();

          if (!api || !isConnected) {
            throw new Error('Not connected to database');
          }

          try {
            const planGraph = await api.explainPlanGraph(sql, { withActual });

            // Update the active result with the query plan graph
            if (activeResultId) {
              set((state) => ({
                ...state,
                queryHistory: state.queryHistory.map(result =>
                  result.id === activeResultId
                    ? { ...result, planGraph: planGraph }
                    : result
                ),
              }));
            }
          } catch (error) {
            console.error('Failed to fetch query plan graph:', error);
            throw error;
          }
        },

        createTab: (name?: string) => {
          const tabId = crypto.randomUUID();
          const tabName = name || `query-${Date.now()}.sql`;

          set((state) => {
            const newTab: Tab = {
              id: tabId,
              name: tabName,
              content: '',
              isActive: true,
              isDirty: false,
            };

            return {
              ...state,
              tabs: [
                ...state.tabs.map(tab => ({ ...tab, isActive: false })),
                newTab,
              ],
              activeTabId: tabId,
            };
          });

          return tabId;
        },

        closeTab: (tabId: string) => {
          set((state) => {
            const tab = state.tabs.find(tab => tab.id === tabId);
            if (!tab) return state;

            // If tab has unsaved changes, show confirmation dialog
            if (tab.isDirty) {
              return {
                ...state,
                unsavedChangesDialog: {
                  isOpen: true,
                  tabId,
                  fileName: tab.name,
                },
              };
            }

            // If no unsaved changes, close immediately
            const tabIndex = state.tabs.findIndex(tab => tab.id === tabId);
            const newTabs = state.tabs.filter(tab => tab.id !== tabId);
            let newActiveTabId = state.activeTabId;

            // If closing the active tab, activate another one
            if (state.activeTabId === tabId) {
              if (newTabs.length > 0) {
                const newActiveTab = newTabs[Math.max(0, tabIndex - 1)];
                newActiveTabId = newActiveTab.id;
                newTabs[Math.max(0, tabIndex - 1)] = { ...newActiveTab, isActive: true };
              } else {
                newActiveTabId = null;
              }
            }

            return {
              ...state,
              tabs: newTabs,
              activeTabId: newActiveTabId,
            };
          });
        },

        forceCloseTab: (tabId: string) => {
          set((state) => {
            const tabIndex = state.tabs.findIndex(tab => tab.id === tabId);
            if (tabIndex === -1) return state;

            const newTabs = state.tabs.filter(tab => tab.id !== tabId);
            let newActiveTabId = state.activeTabId;

            // If closing the active tab, activate another one
            if (state.activeTabId === tabId) {
              if (newTabs.length > 0) {
                const newActiveTab = newTabs[Math.max(0, tabIndex - 1)];
                newActiveTabId = newActiveTab.id;
                newTabs[Math.max(0, tabIndex - 1)] = { ...newActiveTab, isActive: true };
              } else {
                newActiveTabId = null;
              }
            }

            return {
              ...state,
              tabs: newTabs,
              activeTabId: newActiveTabId,
            };
          });
        },

        setActiveTab: (tabId: string) => {
          set((state) => ({
            ...state,
            tabs: state.tabs.map(tab => ({
              ...tab,
              isActive: tab.id === tabId,
            })),
            activeTabId: tabId,
          }));
        },

        updateTabContent: (tabId: string, content: string) => {
          set((state) => ({
            ...state,
            tabs: state.tabs.map(tab =>
              tab.id === tabId
                ? { ...tab, content, isDirty: true }
                : tab
            ),
          }));
        },

        updateTabName: (tabId: string, name: string) => {
          set((state) => ({
            ...state,
            tabs: state.tabs.map(tab =>
              tab.id === tabId
                ? { ...tab, name }
                : tab
            ),
          }));
        },

        setSelectedPanel: (panel: 'result' | 'plan' | 'graph' | 'program' | 'trace' | 'messages') => {
          set((state) => ({
            ...state,
            selectedPanel: panel,
          }));
        },

        setActiveResultId: (resultId: string | null) => {
          set((state) => ({
            ...state,
            activeResultId: resultId,
          }));
        },

        setSelectedNodeId: (nodeId: string | undefined) => {
          const { activeResultId } = get();
          set((state) => ({
            ...state,
            queryHistory: state.queryHistory.map(result =>
              result.id === activeResultId
                ? { ...result, selectedNodeId: nodeId }
                : result
            ),
          }));
        },

        setPlanMode: (mode: 'estimated' | 'actual') => {
          const { activeResultId } = get();
          set((state) => ({
            ...state,
            queryHistory: state.queryHistory.map(result =>
              result.id === activeResultId
                ? { ...result, planMode: mode }
                : result
            ),
          }));
        },

        exportResultsAsCSV: () => {
          const { queryHistory, activeResultId } = get();
          const activeResult = queryHistory.find(result => result.id === activeResultId);

          if (!activeResult?.results || activeResult.results.length === 0) {
            alert('No results to export');
            return;
          }

          const results = activeResult.results;
          const headers = Object.keys(results[0]);

          // Create CSV content
          const csvRows = [
            headers.join(','), // Header row
            ...results.map(row =>
              headers.map(header => {
                const value = row[header];
                if (value === null) return '';
                if (typeof value === 'string' && (value.includes(',') || value.includes('"') || value.includes('\n'))) {
                  return `"${value.replace(/"/g, '""')}"`;
                }
                return String(value);
              }).join(',')
            )
          ];

          const csvContent = csvRows.join('\n');
          const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
          const url = URL.createObjectURL(blob);

          const link = document.createElement('a');
          link.setAttribute('href', url);
          link.setAttribute('download', `query-results-${new Date().getTime()}.csv`);
          link.style.visibility = 'hidden';
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          URL.revokeObjectURL(url);
        },

        exportResultsAsJSON: () => {
          const { queryHistory, activeResultId } = get();
          const activeResult = queryHistory.find(result => result.id === activeResultId);

          if (!activeResult?.results || activeResult.results.length === 0) {
            alert('No results to export');
            return;
          }

          const exportData = {
            query: activeResult.sql,
            executedAt: activeResult.timestamp.toISOString(),
            executionTime: activeResult.executionTime,
            rowCount: activeResult.results.length,
            results: activeResult.results
          };

          const jsonContent = JSON.stringify(exportData, null, 2);
          const blob = new Blob([jsonContent], { type: 'application/json;charset=utf-8;' });
          const url = URL.createObjectURL(blob);

          const link = document.createElement('a');
          link.setAttribute('href', url);
          link.setAttribute('download', `query-results-${new Date().getTime()}.json`);
          link.style.visibility = 'hidden';
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          URL.revokeObjectURL(url);
        },

        saveCurrentTabAsFile: async () => {
          const { activeTabId, tabs } = get();
          const activeTab = tabs.find(tab => tab.id === activeTabId);

          if (!activeTab) {
            throw new Error('No active tab to save');
          }

          let fileName = activeTab.name;

          // Ensure file has .sql extension if it doesn't already have one
          if (!fileName.toLowerCase().endsWith('.sql') && !fileName.toLowerCase().endsWith('.txt')) {
            fileName = fileName.replace(/\.[^/.]+$/, '') + '.sql';
          }

          const content = activeTab.content;

          const blob = new Blob([content], { type: 'text/plain' });
          const url = URL.createObjectURL(blob);

          const link = document.createElement('a');
          link.setAttribute('href', url);
          link.setAttribute('download', fileName);
          link.style.visibility = 'hidden';
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          URL.revokeObjectURL(url);

          // Mark tab as clean after saving
          set((state) => ({
            ...state,
            tabs: state.tabs.map(tab =>
              tab.id === activeTabId
                ? { ...tab, isDirty: false }
                : tab
            ),
          }));
        },

        saveTabAsFile: async (tabId: string) => {
          const { tabs } = get();
          const tab = tabs.find(t => t.id === tabId);

          if (!tab) {
            throw new Error('No such tab');
          }

          let fileName = tab.name;

          // Ensure file has .sql extension if it doesn't already have one
          if (!fileName.toLowerCase().endsWith('.sql') && !fileName.toLowerCase().endsWith('.txt')) {
            fileName = fileName.replace(/\.[^/.]+$/, '') + '.sql';
          }

          const content = tab.content;

          const blob = new Blob([content], { type: 'text/plain' });
          const url = URL.createObjectURL(blob);

          const link = document.createElement('a');
          link.setAttribute('href', url);
          link.setAttribute('download', fileName);
          link.style.visibility = 'hidden';
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          URL.revokeObjectURL(url);

          // Mark tab as clean after saving
          set((state) => ({
            ...state,
            tabs: state.tabs.map(t =>
              t.id === tabId
                ? { ...t, isDirty: false }
                : t
            ),
          }));
        },

        loadSQLFile: () => {
          return new Promise<void>((resolve, reject) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.sql,.txt';
            input.style.visibility = 'hidden';

            input.onchange = (event) => {
              const file = (event.target as HTMLInputElement).files?.[0];
              if (!file) {
                resolve();
                return;
              }

              const reader = new FileReader();
              reader.onload = (e) => {
                try {
                  const content = e.target?.result as string;
                  const fileName = file.name;

                  // Create a new tab with the file content
                  const { createTab, updateTabContent, updateTabName } = get();
                  const tabId = createTab(fileName);
                  updateTabContent(tabId, content);

                  // Mark tab as clean since it's just loaded
                  set((state) => ({
                    ...state,
                    tabs: state.tabs.map(tab =>
                      tab.id === tabId
                        ? { ...tab, isDirty: false }
                        : tab
                    ),
                  }));

                  resolve();
                } catch (error) {
                  reject(new Error(`Failed to read file: ${error instanceof Error ? error.message : error}`));
                }
              };

              reader.onerror = () => {
                reject(new Error('Failed to read file'));
              };

              reader.readAsText(file);
            };

            input.oncancel = () => {
              resolve(); // User cancelled, not an error
            };

            document.body.appendChild(input);
            input.click();
            document.body.removeChild(input);
          });
        },

        showUnsavedChangesDialog: (tabId: string) => {
          set((state) => ({
            ...state,
            unsavedChangesDialog: {
              isOpen: true,
              tabId,
              fileName: state.tabs.find(tab => tab.id === tabId)?.name || '',
            },
          }));
        },

        hideUnsavedChangesDialog: () => {
          set((state) => ({
            ...state,
            unsavedChangesDialog: {
              isOpen: false,
              tabId: null,
              fileName: '',
            },
          }));
        },

        clearHistory: () => {
          set((state) => ({
            ...state,
            queryHistory: [],
            activeResultId: null,
          }));
        },

        disconnect: async () => {
          const { worker, api } = get();

          try {
            if (api) {
              await api.close();
            }
            if (worker) {
              worker.terminate();
            }
          } catch (error) {
            console.warn('Error during disconnect:', error);
          }

          set(() => ({
            isConnected: false,
            worker: null,
            api: null,
            sessionId: null,
          }));
        },

        // Plugin management methods
        installPlugin: async (url: string) => {
          const { api } = get();

          if (!api) {
            throw new Error('Database not connected');
          }

          // Validate URL format
          if (!validatePluginUrl(url)) {
            throw new Error('Invalid plugin URL. Must be https:// or file:// URL ending in .js or .mjs');
          }

          try {
            // Try to load the plugin
            const manifest = await api.loadModule(url, {});

            // Create plugin record
            const pluginRecord: PluginRecord = {
              id: crypto.randomUUID(),
              url,
              enabled: true,
              manifest,
              config: {},
            };

            // Add to settings store
            useSettingsStore.getState().addPlugin(pluginRecord);

            // Update runtime state
            set((state) => ({
              loadedPlugins: new Set([...state.loadedPlugins, pluginRecord.id]),
            }));

            // Clear any previous error
            get().clearPluginError(pluginRecord.id);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            throw new Error(`Failed to install plugin: ${errorMessage}`);
          }
        },

        togglePlugin: async (id: string, enabled: boolean) => {
          const { api, loadedPlugins } = get();
          const plugins = useSettingsStore.getState().plugins;
          const plugin = plugins.find(p => p.id === id);

          if (!plugin) {
            throw new Error('Plugin not found');
          }

          if (!api) {
            throw new Error('Database not connected');
          }

          try {
            if (enabled && !loadedPlugins.has(id)) {
              // Load the plugin
              const manifest = await api.loadModule(plugin.url, plugin.config);

              // Update manifest if it changed
              if (manifest) {
                useSettingsStore.getState().updatePlugin(id, { manifest });
              }

              set((state) => ({
                loadedPlugins: new Set([...state.loadedPlugins, id]),
              }));

              get().clearPluginError(id);
            } else if (!enabled && loadedPlugins.has(id)) {
              // Note: We can't unload modules at runtime, so we just mark as disabled
              // The plugin will not be loaded on next session start
              set((state) => {
                const newLoadedPlugins = new Set(state.loadedPlugins);
                newLoadedPlugins.delete(id);
                return { loadedPlugins: newLoadedPlugins };
              });
            }

            // Update the enabled state
            useSettingsStore.getState().updatePlugin(id, { enabled });
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            set((state) => ({
              pluginErrors: new Map(state.pluginErrors).set(id, errorMessage),
            }));
            throw error;
          }
        },

        updatePluginConfig: async (id: string, config: Record<string, SqlValue>) => {
          const { api, loadedPlugins } = get();
          const plugins = useSettingsStore.getState().plugins;
          const plugin = plugins.find(p => p.id === id);

          if (!plugin) {
            throw new Error('Plugin not found');
          }

          if (!api) {
            throw new Error('Database not connected');
          }

          // Update the config in settings
          useSettingsStore.getState().updatePlugin(id, { config });

          // If plugin is currently loaded, we need to reload it with new config
          if (loadedPlugins.has(id)) {
            try {
              await api.loadModule(plugin.url, config);
              get().clearPluginError(id);
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : 'Unknown error';
              set((state) => ({
                pluginErrors: new Map(state.pluginErrors).set(id, errorMessage),
              }));
              throw error;
            }
          }
        },

        reloadPlugin: async (id: string) => {
          const { api } = get();
          const plugins = useSettingsStore.getState().plugins;
          const plugin = plugins.find(p => p.id === id);

          if (!plugin) {
            throw new Error('Plugin not found');
          }

          if (!api) {
            throw new Error('Database not connected');
          }

          try {
            const manifest = await api.loadModule(plugin.url, plugin.config);

            // Update manifest if it changed
            if (manifest) {
              useSettingsStore.getState().updatePlugin(id, { manifest });
            }

            set((state) => ({
              loadedPlugins: new Set([...state.loadedPlugins, id]),
            }));

            get().clearPluginError(id);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            set((state) => ({
              pluginErrors: new Map(state.pluginErrors).set(id, errorMessage),
            }));
            throw error;
          }
        },

        getPluginError: (id: string) => {
          return get().pluginErrors.get(id);
        },

        clearPluginError: (id: string) => {
          set((state) => {
            const newErrors = new Map(state.pluginErrors);
            newErrors.delete(id);
            return { pluginErrors: newErrors };
          });
        },

        // Helper method to load enabled plugins at startup
        loadEnabledPlugins: async () => {
          const { api } = get();
          if (!api) return;

          // First, load plugins from config if available
          const configState = useConfigStore.getState();
          if (configState.config && configState.config.plugins && configState.config.autoload !== false) {
            const config = interpolateConfigEnvVars(configState.config);
            for (const pluginConfig of config.plugins || []) {
              try {
                const sqlConfig: Record<string, SqlValue> = {};
                if (pluginConfig.config) {
                  for (const [key, value] of Object.entries(pluginConfig.config)) {
                    if (value === null || value === undefined) {
                      sqlConfig[key] = null;
                    } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                      sqlConfig[key] = value;
                    } else {
                      sqlConfig[key] = JSON.stringify(value);
                    }
                  }
                }
                await api.loadModule(pluginConfig.source, sqlConfig);
              } catch (error) {
                console.warn(`Failed to load plugin from config ${pluginConfig.source}:`, error);
              }
            }
          }

          // Then load plugins from settings (legacy plugin storage)
          const plugins = useSettingsStore.getState().plugins;
          const enabledPlugins = plugins.filter(p => p.enabled);

          for (const plugin of enabledPlugins) {
            try {
              const manifest = await api.loadModule(plugin.url, plugin.config);

              // Update manifest if it changed
              if (manifest && (!plugin.manifest || plugin.manifest.version !== manifest.version)) {
                useSettingsStore.getState().updatePlugin(plugin.id, { manifest });
              }

              set((state) => ({
                loadedPlugins: new Set([...state.loadedPlugins, plugin.id]),
              }));

              get().clearPluginError(plugin.id);
            } catch (error) {
              console.error(`Failed to load plugin ${plugin.url}:`, error);
              const errorMessage = error instanceof Error ? error.message : 'Unknown error';
              set((state) => ({
                pluginErrors: new Map(state.pluginErrors).set(plugin.id, errorMessage),
              }));

              // Disable the plugin if it failed to load
              useSettingsStore.getState().updatePlugin(plugin.id, { enabled: false });
            }
          }
        },
      })
    ),
    {
      name: 'quoomb-session',
      version: 1,
      // Only persist tabs, query history, and UI state - not connection state
      partialize: (state) => ({
        tabs: state.tabs,
        activeTabId: state.activeTabId,
        queryHistory: state.queryHistory.slice(0, 50), // Limit history to last 50 queries to avoid localStorage bloat
        activeResultId: state.activeResultId,
        selectedPanel: state.selectedPanel,
      }),
      // Rehydrate callback to ensure proper state restoration
      onRehydrateStorage: () => (state) => {
        if (state) {
          // Ensure all tabs have proper structure and at least one is active
          if (state.tabs && state.tabs.length > 0) {
            const hasActiveTab = state.tabs.some(tab => tab.isActive);
            if (!hasActiveTab) {
              state.tabs[0].isActive = true;
            }
            // Ensure activeTabId is set correctly
            if (!state.activeTabId) {
              state.activeTabId = state.tabs.find(tab => tab.isActive)?.id || state.tabs[0]?.id || null;
            }
          }

          // Convert timestamp strings back to Date objects
          if (state.queryHistory) {
            state.queryHistory = state.queryHistory.map(result => ({
              ...result,
              timestamp: typeof result.timestamp === 'string' ? new Date(result.timestamp) : result.timestamp
            }));
          }
        }
      },
    }
  )
);
