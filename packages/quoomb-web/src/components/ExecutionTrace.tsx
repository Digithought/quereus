import React, { useState } from 'react';
import { useSessionStore } from '../stores/sessionStore.js';
import { Play, AlertTriangle, FileText, Loader, Copy, Check, Clock, ChevronDown, ChevronRight } from 'lucide-react';

export const ExecutionTrace: React.FC = () => {
  const { queryHistory, activeResultId, fetchTrace } = useSessionStore();
  const [isLoadingTrace, setIsLoadingTrace] = useState(false);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [copySuccess, setCopySuccess] = useState(false);
  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set());

  const activeResult = queryHistory.find(result => result.id === activeResultId);

  const toggleStepExpansion = (stepId: number) => {
    const newExpanded = new Set(expandedSteps);
    if (newExpanded.has(stepId)) {
      newExpanded.delete(stepId);
    } else {
      newExpanded.add(stepId);
    }
    setExpandedSteps(newExpanded);
  };

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

    // Build text representation of the trace
    const steps = activeResult.trace.map(row => ({
      stepId: row.step_id as number,
      timestampMs: row.timestamp_ms as number,
      operation: row.operation as string,
      durationMs: row.duration_ms as number | null,
      rowsProcessed: row.rows_processed as number | null,
      memoryUsed: row.memory_used as number | null,
      details: row.details as string | null,
    }));

    steps.sort((a, b) => a.stepId - b.stepId);

    const lines = [
      `Execution Trace for: ${activeResult.sql}`,
      '='.repeat(80),
      ''
    ];

    steps.forEach(step => {
      lines.push(`Step ${step.stepId}: ${step.operation}`);
      if (step.durationMs !== null) {
        lines.push(`  Duration: ${step.durationMs.toFixed(2)}ms`);
      }
      if (step.rowsProcessed !== null) {
        lines.push(`  Rows: ${step.rowsProcessed.toLocaleString()}`);
      }
      if (step.memoryUsed !== null) {
        lines.push(`  Memory: ${(step.memoryUsed / 1024).toFixed(1)}KB`);
      }
      if (step.details) {
        try {
          const details = JSON.parse(step.details);
          lines.push(`  Details: ${JSON.stringify(details, null, 2).split('\n').join('\n    ')}`);
        } catch {
          lines.push(`  Details: ${step.details}`);
        }
      }
      lines.push('');
    });

    lines.push(`Total Steps: ${steps.length}`);

    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch (error) {
      console.error('Failed to copy trace to clipboard:', error);
    }
  };

  const renderTraceTimeline = () => {
    if (!activeResult?.trace || activeResult.trace.length === 0) {
      return null;
    }

    // Build trace steps from the flat trace data
    const steps = activeResult.trace.map(row => ({
      stepId: row.step_id as number,
      timestampMs: row.timestamp_ms as number,
      operation: row.operation as string,
      durationMs: row.duration_ms as number | null,
      rowsProcessed: row.rows_processed as number | null,
      memoryUsed: row.memory_used as number | null,
      details: row.details as string | null,
    }));

    // Sort by step ID
    steps.sort((a, b) => a.stepId - b.stepId);

    return (
      <div className="space-y-2">
        {steps.map((step, index) => {
          const isExpanded = expandedSteps.has(step.stepId);
          const hasDetails = step.details !== null;

          // Parse details to extract input/output info
          let parsedDetails: any = null;
          let inputInfo = '';
          let outputInfo = '';

          if (step.details) {
            try {
              parsedDetails = JSON.parse(step.details);
              // Extract meaningful input/output info
              if (parsedDetails.statementType) inputInfo = `Type: ${parsedDetails.statementType}`;
              if (parsedDetails.hasSubqueries !== undefined) inputInfo += parsedDetails.hasSubqueries ? ' (with subqueries)' : ' (simple)';
              if (parsedDetails.nodeCount) inputInfo = `${parsedDetails.nodeCount} nodes`;
              if (parsedDetails.instructionCount) outputInfo = `${parsedDetails.instructionCount} instructions`;
            } catch {
              // Keep parsedDetails as null if parsing fails
            }
          }

          if (step.rowsProcessed !== null) {
            outputInfo = outputInfo ? `${outputInfo}, ${step.rowsProcessed} rows` : `${step.rowsProcessed} rows`;
          }

          // Determine step color based on operation type
          let stepColor = 'bg-blue-500';
          let stepTextColor = 'text-blue-600 dark:text-blue-400';
          let stepBgColor = 'bg-blue-50 dark:bg-blue-900/10';

          if (step.operation === 'ERROR') {
            stepColor = 'bg-red-500';
            stepTextColor = 'text-red-600 dark:text-red-400';
            stepBgColor = 'bg-red-50 dark:bg-red-900/10';
          } else if (step.operation === 'PARSE') {
            stepColor = 'bg-green-500';
            stepTextColor = 'text-green-600 dark:text-green-400';
            stepBgColor = 'bg-green-50 dark:bg-green-900/10';
          } else if (step.operation === 'PLAN') {
            stepColor = 'bg-purple-500';
            stepTextColor = 'text-purple-600 dark:text-purple-400';
            stepBgColor = 'bg-purple-50 dark:bg-purple-900/10';
          } else if (step.operation === 'EMIT') {
            stepColor = 'bg-orange-500';
            stepTextColor = 'text-orange-600 dark:text-orange-400';
            stepBgColor = 'bg-orange-50 dark:bg-orange-900/10';
          } else if (step.operation === 'SCHEDULE') {
            stepColor = 'bg-yellow-500';
            stepTextColor = 'text-yellow-600 dark:text-yellow-400';
            stepBgColor = 'bg-yellow-50 dark:bg-yellow-900/10';
          }

          return (
            <div key={step.stepId} className={`border border-gray-200 dark:border-gray-700 rounded ${stepBgColor}`}>
              {/* Compact step header */}
              <div
                className={`flex items-center gap-3 p-2 ${hasDetails ? 'cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700' : ''}`}
                onClick={() => hasDetails && toggleStepExpansion(step.stepId)}
              >
                {/* Timeline indicator */}
                <div className="flex flex-col items-center flex-shrink-0">
                  <div className={`w-2.5 h-2.5 rounded-full ${stepColor}`}></div>
                  {index < steps.length - 1 && (
                    <div className="w-0.5 h-4 bg-gray-300 dark:bg-gray-600 mt-1"></div>
                  )}
                </div>

                {/* Step info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    {hasDetails && (
                      <div className="flex-shrink-0">
                        {isExpanded ? (
                          <ChevronDown size={14} className="text-gray-400" />
                        ) : (
                          <ChevronRight size={14} className="text-gray-400" />
                        )}
                      </div>
                    )}

                    <span className="text-xs font-mono bg-gray-200 dark:bg-gray-700 px-1.5 py-0.5 rounded text-gray-600 dark:text-gray-300">
                      #{step.stepId}
                    </span>

                    <span className={`font-medium text-sm ${stepTextColor}`}>
                      {step.operation}
                    </span>

                    {/* Timing info */}
                    {step.durationMs !== null && (
                      <span className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1">
                        <Clock size={12} />
                        {step.durationMs.toFixed(1)}ms
                      </span>
                    )}

                    {/* Memory info */}
                    {step.memoryUsed !== null && (
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {(step.memoryUsed / 1024).toFixed(1)}KB
                      </span>
                    )}
                  </div>

                  {/* Input/Output summary */}
                  <div className="flex gap-4 text-xs text-gray-600 dark:text-gray-400">
                    {inputInfo && (
                      <span className="flex items-center gap-1">
                        <span className="text-blue-500">→</span>
                        <span>In: {inputInfo}</span>
                      </span>
                    )}
                    {outputInfo && (
                      <span className="flex items-center gap-1">
                        <span className="text-green-500">←</span>
                        <span>Out: {outputInfo}</span>
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Expanded details */}
              {isExpanded && hasDetails && parsedDetails && (
                <div className="border-t border-gray-200 dark:border-gray-700 px-2 py-2 bg-gray-50 dark:bg-gray-800">
                  <div className="text-xs">
                    <span className="font-medium text-gray-600 dark:text-gray-400">Details: </span>
                    <pre className="text-gray-700 dark:text-gray-300 mt-1 whitespace-pre-wrap">
                      {JSON.stringify(parsedDetails, null, 2)}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  if (!activeResult) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        <div className="text-center">
          <FileText size={48} className="mx-auto mb-4 text-gray-400" />
          <p>No query selected for trace analysis</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
          Execution Trace
        </h3>

        <div className="flex items-center gap-2">
          {activeResult.trace && (
            <button
              onClick={copyTraceAsText}
              className="flex items-center gap-1 px-2 py-1 text-xs bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 rounded transition-colors"
              title="Copy trace as text"
            >
              {copySuccess ? (
                <>
                  <Check size={12} />
                  Copied!
                </>
              ) : (
                <>
                  <Copy size={12} />
                  Copy
                </>
              )}
            </button>
          )}

          <button
            onClick={handleFetchTrace}
            disabled={isLoadingTrace}
            className="flex items-center gap-2 px-3 py-1 text-sm bg-blue-500 hover:bg-blue-600 disabled:bg-gray-400 text-white rounded transition-colors"
          >
            {isLoadingTrace ? (
              <Loader size={16} className="animate-spin" />
            ) : (
              <Play size={16} />
            )}
            {isLoadingTrace ? 'Tracing...' : 'Trace Execution'}
          </button>
        </div>
      </div>

      {/* Query display */}
      <div className="mb-4">
        <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          Query:
        </h4>
        <div className="bg-gray-100 dark:bg-gray-800 rounded-lg p-3">
          <pre className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap break-words">
            {activeResult.sql}
          </pre>
        </div>
      </div>

      {/* Error display */}
      {traceError && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <div className="flex items-center gap-2 text-red-700 dark:text-red-300">
            <AlertTriangle size={16} />
            <span className="text-sm font-medium">Trace Analysis Failed</span>
          </div>
          <p className="text-sm text-red-600 dark:text-red-400 mt-1">{traceError}</p>
        </div>
      )}

      {/* Trace display */}
      <div className="flex-1 overflow-auto">
        {activeResult.trace ? (
          <div>
            <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
              Execution Timeline ({activeResult.trace.length} steps):
            </h4>

            {activeResult.trace.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                <p>No trace information available</p>
              </div>
            ) : (
              <div className="space-y-4">
                {renderTraceTimeline()}

                {/* Trace explanation */}
                <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4 mt-4">
                  <h5 className="text-sm font-medium text-green-800 dark:text-green-200 mb-2">
                    Trace Reading Guide
                  </h5>
                  <div className="text-sm text-green-700 dark:text-green-300 space-y-1">
                    <p>• Timeline shows execution steps in chronological order</p>
                    <p>• Duration measurements help identify performance bottlenecks</p>
                    <p>• Memory usage indicates resource consumption at each step</p>
                    <p>• Details contain additional metadata about each operation</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-gray-500">
            <div className="text-center">
              <FileText size={48} className="mx-auto mb-4 text-gray-400" />
              <p className="mb-4">Click "Trace Execution" to see the execution timeline</p>
              <p className="text-sm text-gray-400">
                Shows performance data and timing for each compilation step
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
