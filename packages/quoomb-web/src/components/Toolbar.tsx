import React from 'react';
import { useSessionStore } from '../stores/sessionStore.js';
import { useSettingsStore } from '../stores/settingsStore.js';
import { Sun, Moon, Settings, Upload, Download, History } from 'lucide-react';

export const Toolbar: React.FC = () => {
  const { queryHistory, clearHistory } = useSessionStore();
  const { theme, setTheme } = useSettingsStore();

  const handleThemeToggle = () => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  };

  const handleImportCsv = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = async (e) => {
          const csvContent = e.target?.result as string;
          // TODO: Implement CSV import via worker
          console.log('CSV import:', file.name, csvContent);
        };
        reader.readAsText(file);
      }
    };
    input.click();
  };

  return (
    <div className="flex items-center justify-between px-4 py-2 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
      {/* Left side - Logo/Title */}
      <div className="flex items-center gap-4">
        <h1 className="text-xl font-bold text-gray-900 dark:text-white">
          Quoomb
        </h1>
        <div className="text-sm text-gray-500 dark:text-gray-400">
          Quereus SQL Playground
        </div>
      </div>

      {/* Right side - Controls */}
      <div className="flex items-center gap-2">
        {/* Import CSV */}
        <button
          onClick={handleImportCsv}
          className="flex items-center gap-1 px-3 py-1 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
          title="Import CSV file"
        >
          <Upload size={16} />
          Import
        </button>

        {/* Query History */}
        <button
          className="flex items-center gap-1 px-3 py-1 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
          title={`${queryHistory.length} queries in history`}
        >
          <History size={16} />
          {queryHistory.length}
        </button>

        {/* Clear History */}
        {queryHistory.length > 0 && (
          <button
            onClick={clearHistory}
            className="px-2 py-1 text-xs text-gray-500 dark:text-gray-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
            title="Clear query history"
          >
            Clear
          </button>
        )}

        {/* Theme Toggle */}
        <button
          onClick={handleThemeToggle}
          className="p-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
        >
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>

        {/* Settings */}
        <button
          className="p-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
          title="Settings"
        >
          <Settings size={16} />
        </button>
      </div>
    </div>
  );
};
