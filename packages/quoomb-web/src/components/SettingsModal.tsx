import React from 'react';
import { useSettingsStore } from '../stores/settingsStore.js';
import { X, Sun, Moon, Monitor, Eye, EyeOff, Type, Zap } from 'lucide-react';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose }) => {
  const {
    theme,
    setTheme,
    fontSize,
    setFontSize,
    fontFamily,
    setFontFamily,
    wordWrap,
    setWordWrap,
    showLineNumbers,
    setShowLineNumbers,
    showMinimap,
    setShowMinimap,
    autoExecuteOnShiftEnter,
    setAutoExecuteOnShiftEnter,
    showExecutionTime,
    setShowExecutionTime,
    maxHistoryItems,
    setMaxHistoryItems,
    resetToDefaults,
  } = useSettingsStore();

  if (!isOpen) return null;

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const getThemeIcon = (themeOption: string) => {
    switch (themeOption) {
      case 'light':
        return <Sun size={16} />;
      case 'dark':
        return <Moon size={16} />;
      case 'auto':
        return <Monitor size={16} />;
      default:
        return <Monitor size={16} />;
    }
  };

  const fontSizeOptions = [10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24];
  const fontFamilyOptions = [
    '"Fira Code", "Cascadia Code", "JetBrains Mono", Monaco, Consolas, monospace',
    '"Cascadia Code", "Fira Code", "JetBrains Mono", Monaco, Consolas, monospace',
    '"JetBrains Mono", "Fira Code", "Cascadia Code", Monaco, Consolas, monospace',
    '"SF Mono", Monaco, Consolas, monospace',
    'Monaco, Consolas, monospace',
    'Consolas, monospace',
  ];

  const fontDisplayNames = [
    'Fira Code (default)',
    'Cascadia Code',
    'JetBrains Mono',
    'SF Mono',
    'Monaco',
    'Consolas',
  ];

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
      onClick={handleOverlayClick}
    >
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-2xl max-h-[80vh] overflow-y-auto m-4">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Settings</h2>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-8">
          {/* Appearance Section */}
          <section>
            <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-4">Appearance</h3>

            {/* Theme Selection */}
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
                Theme
              </label>
              <div className="flex gap-2">
                {(['auto', 'light', 'dark'] as const).map((themeOption) => (
                  <button
                    key={themeOption}
                    onClick={() => setTheme(themeOption)}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg border transition-colors ${
                      theme === themeOption
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300'
                        : 'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-600'
                    }`}
                  >
                    {getThemeIcon(themeOption)}
                    <span className="capitalize">{themeOption}</span>
                  </button>
                ))}
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                Auto will follow your system theme preference
              </p>
            </div>
          </section>

          {/* Editor Section */}
          <section>
            <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-4">Editor</h3>

            {/* Font Size */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Font Size: {fontSize}px
              </label>
              <select
                value={fontSize}
                onChange={(e) => setFontSize(Number(e.target.value))}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
              >
                {fontSizeOptions.map(size => (
                  <option key={size} value={size}>{size}px</option>
                ))}
              </select>
            </div>

            {/* Font Family */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Font Family
              </label>
              <select
                value={fontFamily}
                onChange={(e) => setFontFamily(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
              >
                {fontFamilyOptions.map((font, index) => (
                  <option key={font} value={font}>{fontDisplayNames[index]}</option>
                ))}
              </select>
            </div>

            {/* Editor Options */}
            <div className="space-y-3">
              <label className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={wordWrap}
                  onChange={(e) => setWordWrap(e.target.checked)}
                  className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">Word wrap</span>
              </label>

              <label className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={showLineNumbers}
                  onChange={(e) => setShowLineNumbers(e.target.checked)}
                  className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">Show line numbers</span>
              </label>

              <label className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={showMinimap}
                  onChange={(e) => setShowMinimap(e.target.checked)}
                  className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">Show minimap</span>
              </label>
            </div>
          </section>

          {/* Query Execution Section */}
          <section>
            <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-4">Query Execution</h3>

            <div className="space-y-3">
              <label className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={autoExecuteOnShiftEnter}
                  onChange={(e) => setAutoExecuteOnShiftEnter(e.target.checked)}
                  className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">Execute on Shift+Enter</span>
              </label>

              <label className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={showExecutionTime}
                  onChange={(e) => setShowExecutionTime(e.target.checked)}
                  className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">Show execution time</span>
              </label>
            </div>

            {/* Max History Items */}
            <div className="mt-4">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Max History Items: {maxHistoryItems}
              </label>
              <input
                type="range"
                min="10"
                max="1000"
                step="10"
                value={maxHistoryItems}
                onChange={(e) => setMaxHistoryItems(Number(e.target.value))}
                className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer"
              />
              <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mt-1">
                <span>10</span>
                <span>1000</span>
              </div>
            </div>
          </section>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-6 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={resetToDefaults}
            className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
          >
            Reset to Defaults
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
