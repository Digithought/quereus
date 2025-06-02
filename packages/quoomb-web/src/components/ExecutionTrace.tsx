import React, { useState } from 'react';
import { useSessionStore } from '../stores/sessionStore.js';
import { Play, AlertTriangle, Activity, Loader, Copy, Check, Info } from 'lucide-react';

export const ExecutionTrace: React.FC = () => {
  const { queryHistory, activeResultId, fetchTrace } = useSessionStore();
  const [isLoadingTrace, setIsLoadingTrace] = useState(false);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [copySuccess, setCopySuccess] = useState(false);
  const [showQuery, setShowQuery] = useState(false);

  const activeResult = queryHistory.find(result => result.id === activeResultId);

  const handleFetchTrace = async () => {
    if (!activeResult) return;

    setIsLoadingTrace(true);
    setTraceError(null);

    try {
      await fetchTrace(activeResult.sql);
    } catch (error) {
      setTraceError(error instanceof Error ? error.message : 'Failed to fetch execution trace');
    } finally {
      setIsLoadingTrace(false);
    }
  };

  const copyTraceAsText = async () => {
    if (!activeResult?.trace || activeResult.trace.length === 0) return;

    const lines = [
      `Execution Trace for: ${activeResult.sql}`,
      '='.repeat(80),
      ''
    ];

    // Sort trace steps by execution order
    const sortedTrace = [...activeResult.trace].sort((a, b) => {
      const stepA = (a.step_id as number) || 0;
      const stepB = (b.step_id as number) || 0;
      return stepA - stepB;
    });

    sortedTrace.forEach(row => {
      const stepId = row.step_id as number;
      const operation = (row.operation as string) || 'UNKNOWN';
      const duration = (row.duration_ms as number) || 0;
      const rowsProcessed = (row.rows_processed as number) || 0;
      const detail = (row.details as string) || '';

      lines.push(`Step ${stepId}: ${operation}`);
      lines.push(`  Duration: ${duration.toFixed(2)}ms`);
      lines.push(`  Rows: ${rowsProcessed.toLocaleString()}`);
      if (detail) {
        lines.push(`  Detail: ${detail}`);
      }
      lines.push('');
    });

    const totalDuration = sortedTrace.reduce((sum, row) => sum + ((row.duration_ms as number) || 0), 0);
    const totalRows = sortedTrace.reduce((sum, row) => sum + ((row.rows_processed as number) || 0), 0);

    lines.push(`Total Steps: ${sortedTrace.length}`);
    lines.push(`Total Duration: ${totalDuration.toFixed(2)}ms`);
    lines.push(`Total Rows Processed: ${totalRows.toLocaleString()}`);

    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch (error) {
      console.error('Failed to copy trace to clipboard:', error);
    }
  };

  if (!activeResult) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 dark:text-gray-400">
        <div className="text-center">
          <Activity size={48} className="mx-auto mb-4 text-gray-400 dark:text-gray-500" />
          <p>No query selected for execution trace</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-white dark:bg-gray-900">
      {/* Compact Header */}
      <div className="flex items-center justify-between p-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
        <div className="flex items-center gap-3">
          <h3 className="font-semibold text-gray-900 dark:text-white">
            Execution Trace
          </h3>

          <button
            onClick={() => setShowQuery(!showQuery)}
            className="p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            title="Toggle query display"
          >
            <Info size={16} />
          </button>
        </div>

        <div className="flex items-center gap-2">
          {activeResult.trace && (
            <button
              onClick={copyTraceAsText}
              className="p-1 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
              title="Copy trace as text"
            >
              {copySuccess ? <Check size={14} /> : <Copy size={14} />}
            </button>
          )}

          <button
            onClick={handleFetchTrace}
            disabled={isLoadingTrace}
            className="flex items-center gap-1 px-2 py-1 text-xs bg-blue-500 hover:bg-blue-600 disabled:bg-gray-400 text-white rounded transition-colors"
          >
            {isLoadingTrace ? (
              <Loader size={14} className="animate-spin" />
            ) : (
              <Play size={14} />
            )}
            {isLoadingTrace ? 'Tracing...' : 'Trace Execution'}
          </button>
        </div>
      </div>

      {/* Collapsible Query display */}
      {showQuery && activeResult && (
        <div className="p-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
          <div className="bg-gray-100 dark:bg-gray-700 rounded p-2">
            <pre className="text-xs text-gray-800 dark:text-gray-200 whitespace-pre-wrap break-words">
              {activeResult.sql}
            </pre>
          </div>
        </div>
      )}

      {/* Error display */}
      {traceError && (
        <div className="p-2 bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800">
          <div className="flex items-center gap-2 text-red-700 dark:text-red-300">
            <AlertTriangle size={16} />
            <span className="text-sm font-medium">Trace Execution Failed</span>
          </div>
          <p className="text-sm text-red-600 dark:text-red-400 mt-1">{traceError}</p>
        </div>
      )}

      {/* Trace display - takes remaining space */}
      <div className="flex-1 overflow-auto">
        {activeResult.trace ? (
          <div className="p-4">
            <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
              Execution Steps ({activeResult.trace.length} traced):
            </h4>

            {activeResult.trace.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                <p>No execution trace data available</p>
              </div>
            ) : (
              <div className="space-y-4">
                {/* Execution timeline */}
                <div className="bg-gray-100 dark:bg-gray-800 rounded-lg overflow-hidden">
                  <div className="bg-gray-200 dark:bg-gray-700 px-4 py-2 border-b border-gray-300 dark:border-gray-600">
                    <div className="grid grid-cols-12 gap-2 text-xs font-medium text-gray-600 dark:text-gray-400">
                      <div className="col-span-1">Step</div>
                      <div className="col-span-2">Operation</div>
                      <div className="col-span-2">Duration</div>
                      <div className="col-span-2">Rows</div>
                      <div className="col-span-5">Details</div>
                    </div>
                  </div>

                  <div className="max-h-96 overflow-y-auto">
                    {activeResult.trace
                      .sort((a, b) => ((a.step_id as number) || 0) - ((b.step_id as number) || 0))
                      .map((row, index) => {
                        const stepId = row.step_id as number;
                        const operation = (row.operation as string) || 'UNKNOWN';
                        const duration = (row.duration_ms as number) || 0;
                        const rowsProcessed = (row.rows_processed as number) || 0;
                        const detail = (row.details as string) || '';

                        // Color coding based on performance
                        let performanceClass = 'text-green-600 dark:text-green-400';
                        if (duration > 100) {
                          performanceClass = 'text-red-600 dark:text-red-400';
                        } else if (duration > 25) {
                          performanceClass = 'text-yellow-600 dark:text-yellow-400';
                        }

                        return (
                          <div
                            key={index}
                            className="grid grid-cols-12 gap-2 px-4 py-2 border-b border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-750 text-sm"
                          >
                            <div className="col-span-1 font-mono text-gray-500 dark:text-gray-400">
                              {stepId}
                            </div>
                            <div className="col-span-2 font-mono font-medium text-blue-600 dark:text-blue-400">
                              {operation}
                            </div>
                            <div className={`col-span-2 font-mono font-medium ${performanceClass}`}>
                              {duration.toFixed(2)}ms
                            </div>
                            <div className="col-span-2 font-mono text-gray-700 dark:text-gray-300">
                              {rowsProcessed.toLocaleString()}
                            </div>
                            <div className="col-span-5 text-gray-600 dark:text-gray-400 text-xs">
                              {detail || '—'}
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </div>

                {/* Trace statistics */}
                <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
                  <h5 className="text-sm font-medium text-blue-800 dark:text-blue-200 mb-2">
                    Execution Statistics
                  </h5>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                    <div>
                      <span className="text-blue-600 dark:text-blue-400">Total Steps:</span>
                      <span className="ml-2 font-medium">{activeResult.trace.length}</span>
                    </div>
                    <div>
                      <span className="text-blue-600 dark:text-blue-400">Total Time:</span>
                      <span className="ml-2 font-medium">
                        {activeResult.trace
                          .reduce((sum, row) => sum + ((row.duration_ms as number) || 0), 0)
                          .toFixed(2)}ms
                      </span>
                    </div>
                    <div>
                      <span className="text-blue-600 dark:text-blue-400">Total Rows:</span>
                      <span className="ml-2 font-medium">
                        {activeResult.trace
                          .reduce((sum, row) => sum + ((row.rows_processed as number) || 0), 0)
                          .toLocaleString()}
                      </span>
                    </div>
                    <div>
                      <span className="text-blue-600 dark:text-blue-400">Avg Step Time:</span>
                      <span className="ml-2 font-medium">
                        {(activeResult.trace
                          .reduce((sum, row) => sum + ((row.duration_ms as number) || 0), 0) /
                          activeResult.trace.length).toFixed(2)}ms
                      </span>
                    </div>
                  </div>
                </div>

                {/* Performance insights */}
                <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
                  <h5 className="text-sm font-medium text-yellow-800 dark:text-yellow-200 mb-2">
                    Performance Insights
                  </h5>
                  <div className="text-sm text-yellow-700 dark:text-yellow-300 space-y-1">
                    {(() => {
                      const slowSteps = activeResult.trace.filter(row => (row.duration_ms as number) > 50);
                      const fastSteps = activeResult.trace.filter(row => (row.duration_ms as number) < 1);
                      const totalTime = activeResult.trace.reduce((sum, row) => sum + ((row.duration_ms as number) || 0), 0);

                      const insights = [];

                      if (slowSteps.length > 0) {
                        insights.push(`• ${slowSteps.length} steps took >50ms (potential bottlenecks)`);
                      }

                      if (fastSteps.length > 0) {
                        insights.push(`• ${fastSteps.length} steps completed in <1ms (very efficient)`);
                      }

                      if (totalTime > 1000) {
                        insights.push(`• Total execution time of ${totalTime.toFixed(0)}ms may indicate complex query`);
                      } else {
                        insights.push(`• Fast execution (${totalTime.toFixed(0)}ms total)`);
                      }

                      insights.push(`• Color coding: Green (<25ms), Yellow (25-100ms), Red (>100ms)`);

                      return insights.map((insight, i) => <p key={i}>{insight}</p>);
                    })()}
                  </div>
                </div>

                {/* Trace explanation */}
                <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
                  <h5 className="text-sm font-medium text-green-800 dark:text-green-200 mb-2">
                    Understanding Execution Traces
                  </h5>
                  <div className="text-sm text-green-700 dark:text-green-300 space-y-1">
                    <p>• Each step represents an actual operation during query execution</p>
                    <p>• Duration shows real wall-clock time spent on each operation</p>
                    <p>• Rows processed indicates the data volume handled at each step</p>
                    <p>• Use this data to identify performance bottlenecks and optimization opportunities</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-gray-500 dark:text-gray-400">
            <div className="text-center">
              <Activity size={48} className="mx-auto mb-4 text-gray-400 dark:text-gray-500" />
              <p className="mb-4">Click "Trace Execution" to see step-by-step timing</p>
              <p className="text-sm text-gray-400 dark:text-gray-500">
                Uses Quereus's execution_trace() function to show actual runtime performance
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
