import React, { useState, useRef, useEffect } from 'react';
import { useSessionStore } from '../stores/sessionStore.js';
import { useSettingsStore, type StorageModuleType } from '../stores/settingsStore.js';
import { Database, Cloud, HardDrive, ChevronDown, Loader, Check } from 'lucide-react';

const DATABASE_OPTIONS: { value: StorageModuleType; label: string; icon: React.ElementType; description: string }[] = [
  { value: 'memory', label: 'Memory', icon: Database, description: 'Temporary, lost on close' },
  { value: 'store', label: 'Persistent', icon: HardDrive, description: 'Saved locally (IndexedDB)' },
  { value: 'sync', label: 'Sync', icon: Cloud, description: 'Syncs across devices' },
];

export const DatabaseSelector: React.FC = () => {
  const { isConnecting, disconnect, initializeSession } = useSessionStore();
  const { storageModule, setStorageModule, syncUrl, setSyncUrl } = useSettingsStore();
  const [editingSyncUrl, setEditingSyncUrl] = useState(syncUrl);
  const [isOpen, setIsOpen] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  // Sync local state with store
  useEffect(() => {
    setEditingSyncUrl(syncUrl);
  }, [syncUrl]);

  const currentOption = DATABASE_OPTIONS.find(opt => opt.value === storageModule) || DATABASE_OPTIONS[0];
  const CurrentIcon = currentOption.icon;

  const handleSyncUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setEditingSyncUrl(e.target.value);
  };

  const handleSyncUrlBlur = () => {
    if (editingSyncUrl !== syncUrl) {
      setSyncUrl(editingSyncUrl);
    }
  };

  const handleSyncUrlKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur();
    }
  };

  const handleSelectDatabase = async (newModule: StorageModuleType) => {
    if (newModule === storageModule) {
      setIsOpen(false);
      return;
    }

    // Warn if switching to sync without a URL configured
    if (newModule === 'sync' && !editingSyncUrl) {
      const confirmed = window.confirm(
        'No sync server URL is configured.\n\nSwitch to Sync mode anyway?'
      );
      if (!confirmed) {
        return;
      }
    }

    // Save any pending URL changes before switching
    if (editingSyncUrl !== syncUrl) {
      setSyncUrl(editingSyncUrl);
    }

    setIsSwitching(true);
    setIsOpen(false);

    try {
      // Disconnect from current database
      await disconnect();

      // Update the storage module setting
      setStorageModule(newModule);

      // Small delay to ensure state is updated
      await new Promise(resolve => setTimeout(resolve, 100));

      // Reconnect with new module
      await initializeSession();
    } catch (error) {
      console.error('Failed to switch database:', error);
      alert(`Failed to switch database: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsSwitching(false);
    }
  };

  const isLoading = isConnecting || isSwitching;

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        disabled={isLoading}
        className="flex items-center gap-2 px-3 py-1.5 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/50 rounded-lg transition-colors border border-blue-200 dark:border-blue-800 disabled:opacity-50"
        title={`Current database: ${currentOption.label}`}
      >
        {isLoading ? (
          <Loader size={16} className="animate-spin" />
        ) : (
          <CurrentIcon size={16} />
        )}
        <span className="font-medium text-sm">{currentOption.label}</span>
        <ChevronDown size={14} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute top-full left-0 mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-1 z-50 min-w-[280px]">
          <div className="px-3 py-2 text-xs font-medium text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-700">
            Select Database Mode
          </div>
          {DATABASE_OPTIONS.map((option) => {
            const Icon = option.icon;
            const isSelected = option.value === storageModule;
            const isSync = option.value === 'sync';
            return (
              <div key={option.value}>
                <button
                  onClick={() => handleSelectDatabase(option.value)}
                  className={`flex items-start gap-3 w-full px-3 py-2.5 text-left transition-colors ${
                    isSelected
                      ? 'bg-blue-50 dark:bg-blue-900/20'
                      : 'hover:bg-gray-50 dark:hover:bg-gray-700'
                  }`}
                >
                  <Icon
                    size={18}
                    className={isSelected ? 'text-blue-500 mt-0.5' : 'text-gray-400 mt-0.5'}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`font-medium text-sm ${
                        isSelected
                          ? 'text-blue-700 dark:text-blue-300'
                          : 'text-gray-700 dark:text-gray-300'
                      }`}>
                        {option.label}
                      </span>
                      {isSelected && <Check size={14} className="text-blue-500" />}
                    </div>
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {option.description}
                    </span>
                  </div>
                </button>
                {/* Sync URL input - shown when sync is selected or being selected */}
                {isSync && (
                  <div className="px-3 pb-2 pt-1">
                    <input
                      type="text"
                      value={editingSyncUrl}
                      onChange={handleSyncUrlChange}
                      onBlur={handleSyncUrlBlur}
                      onKeyDown={handleSyncUrlKeyDown}
                      onClick={(e) => e.stopPropagation()}
                      placeholder="ws://localhost:8080/sync/ws"
                      className="w-full px-2 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400"
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

