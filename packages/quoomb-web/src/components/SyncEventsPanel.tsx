import React, { useEffect, useState } from 'react';
import { useSessionStore } from '../stores/sessionStore.js';
import { useSettingsStore } from '../stores/settingsStore.js';
import { X, Cloud, AlertTriangle, RefreshCw, GitMerge, AlertCircle } from 'lucide-react';
import type { SyncEvent } from '../worker/types.js';

interface ToastNotification {
  id: string;
  event: SyncEvent;
  visible: boolean;
}

export const SyncEventsPanel: React.FC = () => {
  const { syncEvents } = useSessionStore();
  const { storageModule } = useSettingsStore();
  const [toasts, setToasts] = useState<ToastNotification[]>([]);
  const [lastEventCount, setLastEventCount] = useState(0);

  // Only show when sync module is enabled
  if (storageModule !== 'sync') {
    return null;
  }

  // Watch for new events and create toasts
  useEffect(() => {
    if (syncEvents.length > lastEventCount) {
      const newEvents = syncEvents.slice(0, syncEvents.length - lastEventCount);
      const newToasts = newEvents.map((event) => ({
        id: `${event.timestamp}-${Math.random()}`,
        event,
        visible: true,
      }));

      setToasts((prev) => [...newToasts, ...prev].slice(0, 5));
      setLastEventCount(syncEvents.length);

      // Auto-dismiss toasts after 5 seconds
      newToasts.forEach((toast) => {
        setTimeout(() => {
          setToasts((prev) =>
            prev.map((t) => (t.id === toast.id ? { ...t, visible: false } : t))
          );
          // Remove from DOM after fade out
          setTimeout(() => {
            setToasts((prev) => prev.filter((t) => t.id !== toast.id));
          }, 300);
        }, 5000);
      });
    }
  }, [syncEvents, lastEventCount]);

  const dismissToast = (id: string) => {
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, visible: false } : t))
    );
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 300);
  };

  const getEventIcon = (type: SyncEvent['type']) => {
    switch (type) {
      case 'remote-change':
        return <Cloud size={16} className="text-blue-500" />;
      case 'local-change':
        return <RefreshCw size={16} className="text-green-500" />;
      case 'conflict':
        return <GitMerge size={16} className="text-yellow-500" />;
      case 'state-change':
        return <RefreshCw size={16} className="text-gray-500" />;
      case 'error':
        return <AlertCircle size={16} className="text-red-500" />;
      default:
        return <AlertTriangle size={16} className="text-gray-500" />;
    }
  };

  const getEventBgColor = (type: SyncEvent['type']) => {
    switch (type) {
      case 'remote-change':
        return 'bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-800';
      case 'local-change':
        return 'bg-green-50 dark:bg-green-900/30 border-green-200 dark:border-green-800';
      case 'conflict':
        return 'bg-yellow-50 dark:bg-yellow-900/30 border-yellow-200 dark:border-yellow-800';
      case 'error':
        return 'bg-red-50 dark:bg-red-900/30 border-red-200 dark:border-red-800';
      default:
        return 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700';
    }
  };

  if (toasts.length === 0) {
    return null;
  }

  return (
    <div className="fixed bottom-16 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`flex items-start gap-3 p-3 rounded-lg border shadow-lg transition-all duration-300 ${
            getEventBgColor(toast.event.type)
          } ${toast.visible ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-4'}`}
        >
          <div className="flex-shrink-0 mt-0.5">
            {getEventIcon(toast.event.type)}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-gray-900 dark:text-gray-100">
              {toast.event.message}
            </p>
            {toast.event.details && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {toast.event.details.table && `Table: ${toast.event.details.table}`}
                {toast.event.details.changeCount !== undefined && ` • ${toast.event.details.changeCount} changes`}
              </p>
            )}
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
              {new Date(toast.event.timestamp).toLocaleTimeString()}
            </p>
          </div>
          <button
            onClick={() => dismissToast(toast.id)}
            className="flex-shrink-0 p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
          >
            <X size={14} className="text-gray-400" />
          </button>
        </div>
      ))}
    </div>
  );
};

