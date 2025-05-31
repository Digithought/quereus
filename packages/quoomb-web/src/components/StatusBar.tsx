import React from 'react';
import { useSessionStore } from '../stores/sessionStore.js';
import { CheckCircle, AlertCircle, Loader } from 'lucide-react';

export const StatusBar: React.FC = () => {
  const {
    isConnected,
    isConnecting,
    isExecuting,
    currentQuery,
    queryHistory
  } = useSessionStore();

  const getConnectionStatus = () => {
    if (isConnecting) {
      return (
        <div className="flex items-center gap-1 text-yellow-600 dark:text-yellow-400">
          <Loader size={12} className="animate-spin" />
          Connecting...
        </div>
      );
    }

    if (isConnected) {
      return (
        <div className="flex items-center gap-1 text-green-600 dark:text-green-400">
          <CheckCircle size={12} />
          Connected
        </div>
      );
    }

    return (
      <div className="flex items-center gap-1 text-red-600 dark:text-red-400">
        <AlertCircle size={12} />
        Disconnected
      </div>
    );
  };

  return (
    <div className="flex items-center justify-between px-4 py-1 bg-gray-100 dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 text-xs">
      {/* Left side - Connection status */}
      <div className="flex items-center gap-4">
        {getConnectionStatus()}

        {isExecuting && currentQuery && (
          <div className="flex items-center gap-1 text-blue-600 dark:text-blue-400">
            <Loader size={12} className="animate-spin" />
            Executing query...
          </div>
        )}
      </div>

      {/* Right side - Statistics */}
      <div className="flex items-center gap-4 text-gray-500 dark:text-gray-400">
        <span>History: {queryHistory.length} queries</span>
        <span>Quereus SQL Engine</span>
      </div>
    </div>
  );
};
