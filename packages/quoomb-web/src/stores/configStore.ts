import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { QuoombConfig } from '@quereus/quereus';

export interface ConfigState {
  config: QuoombConfig | null;
  
  // Actions
  loadConfig: () => void;
  setConfig: (config: QuoombConfig) => void;
  saveConfig: (config: QuoombConfig) => void;
  clearConfig: () => void;
  
  // Import/Export
  exportConfig: () => string;
  importConfig: (json: string) => QuoombConfig;
}

const STORAGE_KEY = 'quoomb.config';

export const useConfigStore = create<ConfigState>()(
  persist(
    (set, get) => ({
      config: null,

      loadConfig: () => {
        // Config is automatically loaded by the persist middleware
        // This function ensures config is available
      },

      setConfig: (config: QuoombConfig) => {
        set({ config });
      },

      saveConfig: (config: QuoombConfig) => {
        set({ config });
      },

      clearConfig: () => {
        set({ config: null });
      },

      exportConfig: () => {
        const { config } = get();
        if (!config) {
          return JSON.stringify({ plugins: [], autoload: true }, null, 2);
        }
        return JSON.stringify(config, null, 2);
      },

      importConfig: (json: string) => {
        try {
          const config = JSON.parse(json) as QuoombConfig;
          
          // Validate basic structure
          if (typeof config !== 'object' || config === null) {
            throw new Error('Config must be a JSON object');
          }
          
          if (config.plugins !== undefined && !Array.isArray(config.plugins)) {
            throw new Error('plugins must be an array');
          }
          
          if (config.autoload !== undefined && typeof config.autoload !== 'boolean') {
            throw new Error('autoload must be a boolean');
          }
          
          return config;
        } catch (error) {
          throw new Error(`Invalid config JSON: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      },
    }),
    {
      name: STORAGE_KEY,
      version: 1,
    }
  )
);

