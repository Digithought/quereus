import React, { useState } from 'react';
import { useSessionStore } from '../stores/sessionStore.js';
import { useSettingsStore } from '../stores/settingsStore.js';
import { Settings, Upload, Download, History, File } from 'lucide-react';
import { HistoryPanel } from './HistoryPanel.js';
import { ExportMenu } from './ExportMenu.js';
import { CsvImportModal } from './CsvImportModal.js';
import { SettingsModal } from './SettingsModal.js';
import { FileMenu } from './FileMenu.js';

export const Toolbar: React.FC = () => {
  const { queryHistory, clearHistory } = useSessionStore();
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
  const [isCsvImportOpen, setIsCsvImportOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isFileMenuOpen, setIsFileMenuOpen] = useState(false);

  return (
    <div className="flex items-center justify-between px-4 py-2 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
      <div className="flex items-center gap-4">
        <h1 className="text-lg font-semibold text-gray-900 dark:text-white">
          Quoomb
        </h1>
      </div>

      <div className="flex items-center gap-2">
        {/* File Menu */}
        <div className="relative">
          <button
            onClick={() => setIsFileMenuOpen(!isFileMenuOpen)}
            className="flex items-center gap-1 px-3 py-1 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
            title="File operations"
          >
            <File size={16} />
            File
          </button>

          <FileMenu
            isOpen={isFileMenuOpen}
            onClose={() => setIsFileMenuOpen(false)}
          />
        </div>

        {/* CSV Import */}
        <button
          onClick={() => setIsCsvImportOpen(true)}
          className="flex items-center gap-1 px-3 py-1 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
          title="Import CSV"
        >
          <Upload size={16} />
          Import
        </button>

        {/* Export Menu */}
        <div className="relative">
          <button
            onClick={() => setIsExportMenuOpen(!isExportMenuOpen)}
            disabled={queryHistory.length === 0}
            className="flex items-center gap-1 px-3 py-1 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Export results"
          >
            <Download size={16} />
            Export
          </button>

          <ExportMenu
            isOpen={isExportMenuOpen}
            onClose={() => setIsExportMenuOpen(false)}
          />
        </div>

        {/* History */}
        <button
          onClick={() => setIsHistoryOpen(true)}
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

        {/* Settings */}
        <button
          onClick={() => setIsSettingsOpen(true)}
          className="p-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
          title="Settings"
        >
          <Settings size={16} />
        </button>
      </div>

      {/* Modals */}
      <HistoryPanel
        isOpen={isHistoryOpen}
        onClose={() => setIsHistoryOpen(false)}
      />

      <CsvImportModal
        isOpen={isCsvImportOpen}
        onClose={() => setIsCsvImportOpen(false)}
      />

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
      />
    </div>
  );
};
