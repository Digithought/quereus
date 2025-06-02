import React, { useState } from 'react';
import { useSessionStore } from '../stores/sessionStore.js';
import { useSettingsStore } from '../stores/settingsStore.js';
import { X, Plus, Settings, Power, RotateCw, AlertTriangle, CheckCircle, Trash2 } from 'lucide-react';
import type { PluginRecord, PluginSetting } from '../worker/types.js';
import type { SqlValue } from '@quereus/quereus';

interface PluginsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const PluginsModal: React.FC<PluginsModalProps> = ({ isOpen, onClose }) => {
  const { plugins, removePlugin } = useSettingsStore();
  const {
    installPlugin,
    togglePlugin,
    updatePluginConfig,
    reloadPlugin,
    loadedPlugins,
    getPluginError,
    clearPluginError
  } = useSessionStore();

  const [newPluginUrl, setNewPluginUrl] = useState('');
  const [isInstalling, setIsInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [expandedPlugin, setExpandedPlugin] = useState<string | null>(null);
  const [configChanges, setConfigChanges] = useState<Record<string, Record<string, SqlValue>>>({});

  const handleInstallPlugin = async () => {
    if (!newPluginUrl.trim()) return;

    setIsInstalling(true);
    setInstallError(null);

    try {
      await installPlugin(newPluginUrl.trim());
      setNewPluginUrl('');
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : 'Unknown error');
    } finally {
      setIsInstalling(false);
    }
  };

  const handleTogglePlugin = async (plugin: PluginRecord) => {
    try {
      await togglePlugin(plugin.id, !plugin.enabled);
    } catch (error) {
      console.error('Failed to toggle plugin:', error);
      // Error is stored in session store
    }
  };

  const handleReloadPlugin = async (plugin: PluginRecord) => {
    try {
      clearPluginError(plugin.id);
      await reloadPlugin(plugin.id);
    } catch (error) {
      console.error('Failed to reload plugin:', error);
      // Error is stored in session store
    }
  };

  const handleRemovePlugin = (plugin: PluginRecord) => {
    if (confirm(`Remove plugin "${plugin.manifest?.name || plugin.url}"?`)) {
      removePlugin(plugin.id);
    }
  };

  const handleConfigChange = (pluginId: string, key: string, value: SqlValue) => {
    setConfigChanges(prev => ({
      ...prev,
      [pluginId]: {
        ...prev[pluginId],
        [key]: value
      }
    }));
  };

  const handleSaveConfig = async (plugin: PluginRecord) => {
    const changes = configChanges[plugin.id];
    if (!changes) return;

    try {
      const newConfig = { ...plugin.config, ...changes };
      await updatePluginConfig(plugin.id, newConfig);

      // Clear local changes after successful save
      setConfigChanges(prev => {
        const newChanges = { ...prev };
        delete newChanges[plugin.id];
        return newChanges;
      });
    } catch (error) {
      console.error('Failed to save config:', error);
    }
  };

  const renderConfigForm = (plugin: PluginRecord) => {
    if (!plugin.manifest?.settings?.length) {
      return (
        <div className="text-sm text-gray-500 dark:text-gray-400 italic">
          No configuration options available
        </div>
      );
    }

    const hasChanges = configChanges[plugin.id] && Object.keys(configChanges[plugin.id]).length > 0;

    return (
      <div className="space-y-4">
        {plugin.manifest.settings.map((setting: PluginSetting) => {
          const currentValue = configChanges[plugin.id]?.[setting.key] ?? plugin.config[setting.key] ?? setting.default;

          return (
            <div key={setting.key}>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {setting.label}
                {setting.help && (
                  <span className="text-gray-400 text-xs ml-2">({setting.help})</span>
                )}
              </label>

              {setting.type === 'string' && (
                <input
                  type="text"
                  value={String(currentValue || '')}
                  onChange={(e) => handleConfigChange(plugin.id, setting.key, e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                />
              )}

              {setting.type === 'number' && (
                <input
                  type="number"
                  value={Number(currentValue) || 0}
                  onChange={(e) => handleConfigChange(plugin.id, setting.key, Number(e.target.value))}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                />
              )}

              {setting.type === 'boolean' && (
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    checked={Boolean(currentValue)}
                    onChange={(e) => handleConfigChange(plugin.id, setting.key, e.target.checked)}
                    className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                  />
                  <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                    {setting.label}
                  </span>
                </label>
              )}

              {setting.type === 'select' && setting.options && (
                <select
                  value={String(currentValue || '')}
                  onChange={(e) => handleConfigChange(plugin.id, setting.key, e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                >
                  {setting.options.map((option: SqlValue) => (
                    <option key={String(option)} value={String(option)}>
                      {String(option)}
                    </option>
                  ))}
                </select>
              )}
            </div>
          );
        })}

        {hasChanges && (
          <div className="flex justify-end pt-2">
            <button
              onClick={() => handleSaveConfig(plugin)}
              className="px-3 py-1 bg-blue-500 hover:bg-blue-600 text-white rounded text-sm transition-colors"
            >
              Save Configuration
            </button>
          </div>
        )}
      </div>
    );
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-4xl max-h-[80vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
            Plugin Manager
          </h2>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto max-h-[60vh]">
          {/* Install new plugin */}
          <div className="mb-6 p-4 bg-gray-50 dark:bg-gray-700 rounded-lg">
            <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-3">
              Install New Plugin
            </h3>

            <div className="flex gap-3">
              <input
                type="url"
                value={newPluginUrl}
                onChange={(e) => setNewPluginUrl(e.target.value)}
                placeholder="https://raw.githubusercontent.com/user/repo/main/plugin.js"
                className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
              />
              <button
                onClick={handleInstallPlugin}
                disabled={!newPluginUrl.trim() || isInstalling}
                className="flex items-center gap-2 px-4 py-2 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-400 text-white rounded-md transition-colors"
              >
                {isInstalling ? (
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : (
                  <Plus size={16} />
                )}
                {isInstalling ? 'Installing...' : 'Install'}
              </button>
            </div>

            {installError && (
              <div className="mt-3 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md">
                <div className="flex items-center gap-2 text-red-700 dark:text-red-300">
                  <AlertTriangle size={16} />
                  <span className="text-sm font-medium">Installation Failed</span>
                </div>
                <p className="text-sm text-red-600 dark:text-red-400 mt-1">{installError}</p>
              </div>
            )}

            <div className="mt-3 text-sm text-gray-600 dark:text-gray-400">
              <p>• Enter a URL to an ES module that exports a plugin</p>
              <p>• GitHub raw URLs and jsDelivr CDN links work well</p>
              <p>• Only install plugins from sources you trust</p>
            </div>
          </div>

          {/* Installed plugins */}
          <div>
            <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-4">
              Installed Plugins ({plugins.length})
            </h3>

            {plugins.length === 0 ? (
              <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                <p>No plugins installed yet</p>
              </div>
            ) : (
              <div className="space-y-3">
                {plugins.map((plugin) => {
                  const isLoaded = loadedPlugins.has(plugin.id);
                  const error = getPluginError(plugin.id);
                  const isExpanded = expandedPlugin === plugin.id;

                  return (
                    <div key={plugin.id} className="border border-gray-200 dark:border-gray-700 rounded-lg">
                      {/* Plugin header */}
                      <div className="p-4">
                        <div className="flex items-center justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-3">
                              <h4 className="font-medium text-gray-900 dark:text-white">
                                {plugin.manifest?.name || 'Unknown Plugin'}
                              </h4>
                              {plugin.manifest?.version && (
                                <span className="text-sm text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 px-2 py-1 rounded">
                                  v{plugin.manifest.version}
                                </span>
                              )}
                              {plugin.enabled && isLoaded && !error && (
                                <CheckCircle size={16} className="text-green-500" />
                              )}
                              {error && (
                                <AlertTriangle size={16} className="text-red-500" />
                              )}
                            </div>

                            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                              {plugin.manifest?.description || plugin.url}
                            </p>

                            {plugin.manifest?.author && (
                              <p className="text-xs text-gray-500 dark:text-gray-500 mt-1">
                                by {plugin.manifest.author}
                              </p>
                            )}
                          </div>

                          <div className="flex items-center gap-2">
                            {/* Configure button */}
                            {plugin.manifest?.settings?.length && (
                              <button
                                onClick={() => setExpandedPlugin(isExpanded ? null : plugin.id)}
                                className="p-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white rounded transition-colors"
                                title="Configure"
                              >
                                <Settings size={16} />
                              </button>
                            )}

                            {/* Reload button */}
                            <button
                              onClick={() => handleReloadPlugin(plugin)}
                              className="p-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white rounded transition-colors"
                              title="Reload plugin"
                            >
                              <RotateCw size={16} />
                            </button>

                            {/* Toggle button */}
                            <button
                              onClick={() => handleTogglePlugin(plugin)}
                              className={`p-2 rounded transition-colors ${
                                plugin.enabled
                                  ? 'text-green-600 hover:text-green-700'
                                  : 'text-gray-400 hover:text-gray-600'
                              }`}
                              title={plugin.enabled ? 'Disable plugin' : 'Enable plugin'}
                            >
                              <Power size={16} />
                            </button>

                            {/* Remove button */}
                            <button
                              onClick={() => handleRemovePlugin(plugin)}
                              className="p-2 text-red-600 hover:text-red-700 rounded transition-colors"
                              title="Remove plugin"
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                        </div>

                        {/* Error display */}
                        {error && (
                          <div className="mt-3 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md">
                            <div className="flex items-center gap-2 text-red-700 dark:text-red-300">
                              <AlertTriangle size={16} />
                              <span className="text-sm font-medium">Plugin Error</span>
                            </div>
                            <p className="text-sm text-red-600 dark:text-red-400 mt-1">{error}</p>
                          </div>
                        )}
                      </div>

                      {/* Configuration panel */}
                      {isExpanded && (
                        <div className="border-t border-gray-200 dark:border-gray-700 p-4 bg-gray-50 dark:bg-gray-800">
                          <h5 className="text-sm font-medium text-gray-900 dark:text-white mb-3">
                            Configuration
                          </h5>
                          {renderConfigForm(plugin)}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end p-6 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 rounded transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
