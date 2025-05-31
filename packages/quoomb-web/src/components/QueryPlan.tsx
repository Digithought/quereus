import React from 'react';
import { useSessionStore } from '../stores/sessionStore.js';

export const QueryPlan: React.FC = () => {
  const { queryHistory, activeResultId } = useSessionStore();

  const activeResult = queryHistory.find(result => result.id === activeResultId);

  if (!activeResult) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        <p>No query selected for plan analysis</p>
      </div>
    );
  }

  return (
    <div className="p-4">
      <h3 className="text-lg font-semibold mb-4">Query Execution Plan</h3>

      <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 font-mono text-sm">
        <div className="text-gray-600 dark:text-gray-400 mb-2">
          Query: {activeResult.sql}
        </div>

        <div className="text-orange-600 dark:text-orange-400">
          ⚠️ Query plan analysis coming in Phase 3
        </div>

        <div className="mt-4 text-xs text-gray-500">
          This feature will show:
          <ul className="list-disc list-inside mt-2 space-y-1">
            <li>Query execution tree</li>
            <li>Table scan operations</li>
            <li>Join strategies</li>
            <li>Index usage</li>
            <li>Estimated costs and row counts</li>
          </ul>
        </div>
      </div>
    </div>
  );
};
