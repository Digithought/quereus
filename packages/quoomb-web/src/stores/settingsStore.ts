import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'light' | 'dark' | 'auto';

export interface SettingsState {
  // Appearance
  theme: Theme;
  fontSize: number;
  fontFamily: string;

  // Editor preferences
  autoSave: boolean;
  autoSaveDelay: number;
  wordWrap: boolean;
  showLineNumbers: boolean;
  showMinimap: boolean;

  // Query execution
  autoExecuteOnShiftEnter: boolean;
  showExecutionTime: boolean;
  maxHistoryItems: number;

  // Layout
  defaultPanelSizes: {
    editor: number;
    results: number;
  };

  // Actions
  loadSettings: () => void;
  setTheme: (theme: Theme) => void;
  setFontSize: (size: number) => void;
  setFontFamily: (family: string) => void;
  setAutoSave: (enabled: boolean) => void;
  setAutoSaveDelay: (delay: number) => void;
  setWordWrap: (enabled: boolean) => void;
  setShowLineNumbers: (enabled: boolean) => void;
  setShowMinimap: (enabled: boolean) => void;
  setAutoExecuteOnShiftEnter: (enabled: boolean) => void;
  setShowExecutionTime: (enabled: boolean) => void;
  setMaxHistoryItems: (max: number) => void;
  setPanelSizes: (sizes: { editor: number; results: number }) => void;
  resetToDefaults: () => void;
}

const defaultSettings = {
  theme: 'auto' as Theme,
  fontSize: 14,
  fontFamily: '"Fira Code", "Cascadia Code", "JetBrains Mono", Monaco, Consolas, monospace',

  autoSave: true,
  autoSaveDelay: 2000,
  wordWrap: true,
  showLineNumbers: true,
  showMinimap: false,

  autoExecuteOnShiftEnter: true,
  showExecutionTime: true,
  maxHistoryItems: 100,

  defaultPanelSizes: {
    editor: 50,
    results: 50,
  },
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      ...defaultSettings,

      loadSettings: () => {
        // Settings are automatically loaded by the persist middleware
        // This function exists for explicit loading if needed
        const settings = get();

        // Apply theme to document
        const resolvedTheme = settings.theme === 'auto'
          ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
          : settings.theme;

        document.documentElement.setAttribute('data-theme', resolvedTheme);
      },

      setTheme: (theme: Theme) => {
        set((state) => ({
          ...state,
          theme,
        }));

        // Apply theme immediately
        const resolvedTheme = theme === 'auto'
          ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
          : theme;

        document.documentElement.setAttribute('data-theme', resolvedTheme);
      },

      setFontSize: (size: number) => {
        set((state) => ({
          ...state,
          fontSize: Math.max(8, Math.min(32, size)),
        }));
      },

      setFontFamily: (family: string) => {
        set((state) => ({
          ...state,
          fontFamily: family,
        }));
      },

      setAutoSave: (enabled: boolean) => {
        set((state) => ({
          ...state,
          autoSave: enabled,
        }));
      },

      setAutoSaveDelay: (delay: number) => {
        set((state) => ({
          ...state,
          autoSaveDelay: Math.max(500, Math.min(10000, delay)),
        }));
      },

      setWordWrap: (enabled: boolean) => {
        set((state) => ({
          ...state,
          wordWrap: enabled,
        }));
      },

      setShowLineNumbers: (enabled: boolean) => {
        set((state) => ({
          ...state,
          showLineNumbers: enabled,
        }));
      },

      setShowMinimap: (enabled: boolean) => {
        set((state) => ({
          ...state,
          showMinimap: enabled,
        }));
      },

      setAutoExecuteOnShiftEnter: (enabled: boolean) => {
        set((state) => ({
          ...state,
          autoExecuteOnShiftEnter: enabled,
        }));
      },

      setShowExecutionTime: (enabled: boolean) => {
        set((state) => ({
          ...state,
          showExecutionTime: enabled,
        }));
      },

      setMaxHistoryItems: (max: number) => {
        set((state) => ({
          ...state,
          maxHistoryItems: Math.max(10, Math.min(1000, max)),
        }));
      },

      setPanelSizes: (sizes: { editor: number; results: number }) => {
        set((state) => ({
          ...state,
          defaultPanelSizes: { ...sizes },
        }));
      },

      resetToDefaults: () => {
        set(() => ({ ...defaultSettings }));

        // Reapply theme
        const resolvedTheme = defaultSettings.theme === 'auto'
          ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
          : defaultSettings.theme;

        document.documentElement.setAttribute('data-theme', resolvedTheme);
      },
    }),
    {
      name: 'quoomb-settings',
      version: 1,
    }
  )
);

// Listen for system theme changes when theme is set to 'auto'
if (typeof window !== 'undefined') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    const { theme } = useSettingsStore.getState();
    if (theme === 'auto') {
      document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
    }
  });
}
