import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { SqlValue } from '@quereus/quereus';
import { QuereusWorkerAPI } from '../worker/types.js';
import * as Comlink from 'comlink';

export interface QueryResult {
  id: string;
  sql: string;
  results?: Record<string, SqlValue>[];
  error?: string;
  executionTime: number;
  timestamp: Date;
  queryPlan?: Record<string, SqlValue>[];
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
  selectedPanel: 'result' | 'plan' | 'messages';

  // Actions
  initializeSession: () => Promise<void>;
  executeSQL: (sql: string) => Promise<void>;
  fetchQueryPlan: (sql: string) => Promise<void>;
  createTab: (name?: string) => string;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  updateTabContent: (tabId: string, content: string) => void;
  setSelectedPanel: (panel: 'result' | 'plan' | 'messages') => void;
  setActiveResultId: (resultId: string | null) => void;
  exportResultsAsCSV: () => void;
  exportResultsAsJSON: () => void;
  clearHistory: () => void;
  disconnect: () => Promise<void>;
}

export const useSessionStore = create<SessionState>()(
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

          set((state) => ({
            ...state,
            worker,
            api,
            sessionId,
            isConnected: true,
            isConnecting: false,
            tabs: state.tabs.length === 0 ? [initialTab] : state.tabs,
            activeTabId: state.tabs.length === 0 ? initialTab.id : state.activeTabId,
          }));
        } catch (error) {
          set(() => ({
            isConnecting: false,
            connectionError: error instanceof Error ? error.message : 'Failed to initialize session',
          }));
        }
      },

      executeSQL: async (sql: string) => {
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

          const queryResult: QueryResult = {
            id: resultId,
            sql,
            error: errorMessage,
            executionTime,
            timestamp: new Date(),
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

      setSelectedPanel: (panel: 'result' | 'plan' | 'messages') => {
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
    })
  )
);
