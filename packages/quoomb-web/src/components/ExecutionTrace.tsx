import React, { useState } from 'react';
import { useSessionStore } from '../stores/sessionStore.js';
import { Play, AlertTriangle, Activity, Loader, Copy, Check, Info, ChevronDown, ChevronRight, ArrowDown } from 'lucide-react';

export const ExecutionTrace: React.FC = () => {
  const { queryHistory, activeResultId, fetchTrace, fetchRowTrace } = useSessionStore();
  const [isLoadingTrace, setIsLoadingTrace] = useState(false);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [copySuccess, setCopySuccess] = useState(false);
  const [showQuery, setShowQuery] = useState(false);
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set());
  const [includeRowData, setIncludeRowData] = useState(true);

  const activeResult = queryHistory.find(result => result.id === activeResultId);

  const handleFetchTrace = async () => {
    if (!activeResult) return;

    setIsLoadingTrace(true);
    setTraceError(null);

    try {
      // Always fetch instruction trace
      await fetchTrace(activeResult.sql);
      // Conditionally fetch row trace
      if (includeRowData) {
        await fetchRowTrace(activeResult.sql);
      }
    } catch (error) {
      setTraceError(error instanceof Error ? error.message : 'Failed to fetch execution trace');
    } finally {
      setIsLoadingTrace(false);
    }
  };

  const toggleEventExpansion = (eventId: string) => {
    const newExpanded = new Set(expandedEvents);
    if (newExpanded.has(eventId)) {
      newExpanded.delete(eventId);
    } else {
      newExpanded.add(eventId);
    }
    setExpandedEvents(newExpanded);
  };

  // Build integrated trace data combining instructions with their rows
  const buildIntegratedTrace = () => {
    if (!activeResult?.trace) return { instructions: [], startTime: 0, finalOutput: null };

    const instructionInfo = new Map<number, { dependencies: number[], operation: string }>();
    const rowsByInstruction = new Map<number, any[]>();

    // Calculate start time for relative timestamps
    const startTime = Math.min(...activeResult.trace.map(row => (row.timestamp_ms as number) || 0));

    // Process instruction trace
    activeResult.trace.forEach(row => {
      const instrIndex = (row.instruction_index as number) || 0;
      const dependencies = row.dependencies ? JSON.parse(row.dependencies as string) : [];
      const operation = (row.operation as string) || 'Unknown';
      instructionInfo.set(instrIndex, { dependencies, operation });
    });

    // Process row trace if available and enabled
    if (includeRowData && activeResult.rowTrace) {
      activeResult.rowTrace.forEach(row => {
        const instrIndex = (row.instruction_index as number) || 0;
        if (!rowsByInstruction.has(instrIndex)) {
          rowsByInstruction.set(instrIndex, []);
        }
        rowsByInstruction.get(instrIndex)!.push(row);
      });
    }

    // Topological sort for dependency order
    const instructionIndexes = Array.from(instructionInfo.keys()).sort((a, b) => a - b);
    const visited = new Set<number>();
    const visiting = new Set<number>();
    const result: number[] = [];

    const visit = (instrIndex: number) => {
      if (visiting.has(instrIndex) || visited.has(instrIndex)) return;
      visiting.add(instrIndex);
      const info = instructionInfo.get(instrIndex);
      if (info) {
        info.dependencies.forEach(depIndex => {
          if (instructionInfo.has(depIndex)) visit(depIndex);
        });
      }
      visiting.delete(instrIndex);
      visited.add(instrIndex);
      result.push(instrIndex);
    };

    instructionIndexes.forEach(visit);

    const instructions = result.map(instrIndex => {
      const traceRow = activeResult.trace!.find(r => r.instruction_index === instrIndex);
      const rowData = rowsByInstruction.get(instrIndex) || [];
      const info = instructionInfo.get(instrIndex);

      return {
        instructionIndex: instrIndex,
        traceRow,
        rowData: rowData.sort((a, b) => (a.row_index || 0) - (b.row_index || 0)),
        dependencies: info?.dependencies || [],
        operation: info?.operation || 'Unknown',
        relativeTime: ((traceRow?.timestamp_ms as number) || startTime) - startTime
      };
    });

    // Find final output from the last instruction that has dependencies pointing to it
    const lastInstructionIndex = Math.max(...instructionIndexes);
    const lastInstruction = activeResult.trace.find(r => r.instruction_index === lastInstructionIndex);
    const finalOutput = lastInstruction?.output_value as string || null;

    return { instructions, startTime, finalOutput };
  };

  const copyTraceAsText = async () => {
    if (!activeResult?.trace || activeResult.trace.length === 0 || !activeResult) return;

    const { instructions, finalOutput } = buildIntegratedTrace();
    const lines = [
      `Execution Trace for: ${activeResult.sql}`,
      '='.repeat(80),
      ''
    ];

    instructions.forEach(({ instructionIndex, traceRow, rowData, dependencies, operation, relativeTime }) => {
      lines.push(`[${instructionIndex}] ${operation} (+${relativeTime}ms)`);

      const duration = (traceRow?.duration_ms as number) || 0;
      const inputValues = (traceRow?.input_values as string) || '';
      const outputValue = (traceRow?.output_value as string) || '';

      // Parse and display input values with source indexes
      if (inputValues) {
        try {
          const parsed = JSON.parse(inputValues);
          const values = Array.isArray(parsed) ? parsed : [parsed];
          const inputsWithSources = values.map((val, i) => {
            const sourceIndex = dependencies[i];
            const value = typeof val === 'string' ? val : JSON.stringify(val);
            return sourceIndex !== undefined ? `[${sourceIndex}]${value}` : value;
          });
          lines.push(`  Input: ${inputsWithSources.join(', ')}`);
        } catch {
          const sourceIndex = dependencies[0];
          lines.push(`  Input: ${sourceIndex !== undefined ? `[${sourceIndex}]` : ''}${inputValues}`);
        }
      }

      if (duration > 0) lines.push(`  Duration: ${duration.toFixed(2)}ms`);
      if (outputValue) lines.push(`  Output: ${outputValue}`);
      if (rowData.length > 0) {
        lines.push(`  Rows: ${rowData.length}`);
        rowData.slice(0, 3).forEach((row, i) => {
          const { startTime } = buildIntegratedTrace();
          const rowRelativeTime = ((row.timestamp_ms as number) || startTime) - startTime;
          lines.push(`    ${i + 1}: ${row.row_data || ''} (+${rowRelativeTime}ms)`);
        });
        if (rowData.length > 3) lines.push(`    ... and ${rowData.length - 3} more`);
      }
      lines.push('');
    });

    if (finalOutput) {
      lines.push('Final Output:');
      lines.push(finalOutput);
    }

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

  const { instructions: integratedTrace, finalOutput } = buildIntegratedTrace();

  return (
    <div className="h-full flex flex-col bg-white dark:bg-gray-900">
      {/* Compact Header */}
      <div className="flex items-center justify-between p-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
        <div className="flex items-center gap-3">
          <h3 className="font-semibold text-gray-900 dark:text-white">Execution Trace</h3>
          <button
            onClick={() => setShowQuery(!showQuery)}
            className="p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            title="Toggle query display"
          >
            <Info size={16} />
          </button>
        </div>

        <div className="flex items-center gap-2">
          {/* Row data toggle */}
          <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400">
            <input
              type="checkbox"
              checked={includeRowData}
              onChange={(e) => setIncludeRowData(e.target.checked)}
              className="w-3 h-3"
            />
            Include rows
          </label>

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

      {/* Integrated trace display */}
      <div className="flex-1 overflow-auto">
        {activeResult.trace && integratedTrace.length > 0 ? (
          <div className="p-4">
            <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
              Execution Flow ({integratedTrace.length} instructions):
            </h4>

            <div className="space-y-1">
              {integratedTrace.map(({ instructionIndex, traceRow, rowData, dependencies, operation, relativeTime }, index) => {
                const eventId = `instruction-${instructionIndex}`;
                const isExpanded = expandedEvents.has(eventId);

                const duration = (traceRow?.duration_ms as number) || 0;
                const inputValues = (traceRow?.input_values as string) || '';
                const outputValue = (traceRow?.output_value as string) || '';
                const errorMessage = (traceRow?.error_message as string) || '';
                const hasDetailedData = inputValues || outputValue || errorMessage || rowData.length > 0;

                // Parse input values for inline display with source instruction prefixes
                let parsedInputs: Array<{ value: string; sourceIndex?: number }> = [];
                if (inputValues) {
                  try {
                    const parsed = JSON.parse(inputValues);
                    if (Array.isArray(parsed)) {
                      parsedInputs = parsed.map((val, i) => ({
                        value: typeof val === 'string' ? val : JSON.stringify(val),
                        sourceIndex: dependencies[i] // Map to corresponding dependency
                      }));
                    } else {
                      parsedInputs = [{
                        value: typeof parsed === 'string' ? parsed : JSON.stringify(parsed),
                        sourceIndex: dependencies[0]
                      }];
                    }
                  } catch {
                    parsedInputs = [{
                      value: inputValues,
                      sourceIndex: dependencies[0]
                    }];
                  }
                }

                return (
                  <div key={instructionIndex}>
                    {/* Flow arrow from dependencies */}
                    {index > 0 && dependencies.length > 0 && (
                      <div className="flex items-center justify-center py-1">
                        <div className="flex items-center text-gray-400 dark:text-gray-500">
                          <ArrowDown size={12} />
                        </div>
                      </div>
                    )}

                    {/* Compact instruction row */}
                    <div className="group border border-gray-200 dark:border-gray-700 rounded hover:border-gray-300 dark:hover:border-gray-600 transition-colors">
                      <div className="flex items-center justify-between p-2 bg-gray-50 dark:bg-gray-800/50">
                        <div className="flex items-center gap-3 flex-1 min-w-0">
                          {/* Expand button - only show if there's detailed data */}
                          {hasDetailedData ? (
                            <button
                              onClick={() => toggleEventExpansion(eventId)}
                              className="flex-shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                            >
                              {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            </button>
                          ) : (
                            <div className="w-[14px] flex-shrink-0" /> // Spacer
                          )}

                          {/* Instruction info */}
                          <div className="flex items-center gap-2 flex-1 min-w-0">
                            <span className="font-mono text-sm text-blue-600 dark:text-blue-400 flex-shrink-0">
                              [{instructionIndex}]
                            </span>
                            <span className="font-medium text-gray-900 dark:text-white truncate">
                              {operation}
                            </span>

                            {/* Input values with source instruction prefixes */}
                            {parsedInputs.length > 0 && (
                              <div className="flex items-center gap-1 text-xs flex-shrink-0 max-w-md">
                                <span className="text-gray-500 dark:text-gray-400">←</span>
                                {parsedInputs.map((input, i) => {
                                  const displayValue = input.value;
                                  const shouldTruncate = displayValue.length > 80;
                                  const truncatedValue = shouldTruncate ? `${displayValue.substring(0, 80)}...` : displayValue;

                                  return (
                                    <div key={i} className="relative group flex items-center">
                                      {/* Source instruction index prefix */}
                                      {input.sourceIndex !== undefined && (
                                        <span className="font-mono text-blue-500 dark:text-blue-400 mr-1">
                                          [{input.sourceIndex}]
                                        </span>
                                      )}
                                      {/* Input value */}
                                      <span className="font-mono text-orange-600 dark:text-orange-400 truncate inline-block max-w-60">
                                        {truncatedValue}
                                      </span>
                                      {/* Hover tooltip for full value */}
                                      {shouldTruncate && (
                                        <div className="absolute bottom-full left-0 mb-1 hidden group-hover:block z-10 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-xs p-2 rounded shadow-lg max-w-sm break-words">
                                          {input.sourceIndex !== undefined && (
                                            <div className="text-blue-300 dark:text-blue-600 mb-1">
                                              From instruction [{input.sourceIndex}]:
                                            </div>
                                          )}
                                          {displayValue}
                                        </div>
                                      )}
                                      {i < parsedInputs.length - 1 && <span className="text-gray-400 mx-1">,</span>}
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>

                          {/* Summary stats */}
                          <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400 flex-shrink-0">
                            <span>+{relativeTime}ms</span>
                            {duration > 0 && (
                              <span>({duration.toFixed(1)}ms)</span>
                            )}
                            {rowData.length > 0 && (
                              <span className="text-green-600 dark:text-green-400">
                                {rowData.length} row{rowData.length !== 1 ? 's' : ''}
                              </span>
                            )}
                            {errorMessage && (
                              <span className="text-red-600 dark:text-red-400">Error</span>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Expanded details */}
                      {isExpanded && hasDetailedData && (
                        <div className="border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
                          <div className="p-3 space-y-3">
                            {/* Input/Output in compact format */}
                            {(inputValues || outputValue) && (
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                                {inputValues && (
                                  <div>
                                    <div className="font-medium text-blue-600 dark:text-blue-400 mb-1">Input:</div>
                                    <div className="bg-blue-50 dark:bg-blue-900/20 rounded p-2 font-mono">
                                      <pre className="whitespace-pre-wrap break-words">{inputValues}</pre>
                                    </div>
                                  </div>
                                )}
                                {outputValue && (
                                  <div>
                                    <div className="font-medium text-green-600 dark:text-green-400 mb-1">Output:</div>
                                    <div className="bg-green-50 dark:bg-green-900/20 rounded p-2 font-mono">
                                      <pre className="whitespace-pre-wrap break-words">{outputValue}</pre>
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}

                            {/* Row data */}
                            {rowData.length > 0 && (
                              <div>
                                <div className="font-medium text-purple-600 dark:text-purple-400 mb-2">
                                  Row Data ({rowData.length} rows):
                                </div>
                                <div className="space-y-1 max-h-40 overflow-y-auto">
                                  {rowData.map((row, i) => {
                                    const { startTime } = buildIntegratedTrace();
                                    const rowRelativeTime = ((row.timestamp_ms as number) || startTime) - startTime;

                                    return (
                                      <div key={i} className="flex items-center gap-2 text-xs bg-purple-50 dark:bg-purple-900/20 rounded p-2">
                                        <span className="text-purple-600 dark:text-purple-400 font-mono flex-shrink-0">
                                          #{row.row_index || i}:
                                        </span>
                                        <span className="font-mono flex-1 truncate">{row.row_data || ''}</span>
                                        <span className="text-gray-500 dark:text-gray-400 flex-shrink-0">
                                          +{rowRelativeTime}ms
                                        </span>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            )}

                            {/* Error message */}
                            {errorMessage && (
                              <div>
                                <div className="font-medium text-red-600 dark:text-red-400 mb-1">Error:</div>
                                <div className="bg-red-50 dark:bg-red-900/20 rounded p-2 text-xs text-red-700 dark:text-red-300">
                                  {errorMessage}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Final Output Box */}
            {finalOutput && (
              <div className="mt-4 border border-green-200 dark:border-green-700 rounded-lg bg-green-50 dark:bg-green-900/20">
                <div className="p-3">
                  <div className="font-medium text-green-800 dark:text-green-200 mb-2">Final Output:</div>
                  <div className="bg-white dark:bg-gray-800 rounded p-2 text-sm font-mono">
                    <pre className="whitespace-pre-wrap break-words text-gray-900 dark:text-gray-100">{finalOutput}</pre>
                  </div>
                </div>
              </div>
            )}

            {/* Summary statistics */}
            <div className="mt-6 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
              <h5 className="text-sm font-medium text-blue-800 dark:text-blue-200 mb-2">
                Execution Summary
              </h5>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div>
                  <span className="text-blue-600 dark:text-blue-400">Instructions:</span>
                  <span className="ml-2 font-medium">{integratedTrace.length}</span>
                </div>
                <div>
                  <span className="text-blue-600 dark:text-blue-400">Total Duration:</span>
                  <span className="ml-2 font-medium">
                    {integratedTrace.reduce((sum, t) => sum + ((t.traceRow?.duration_ms as number) || 0), 0).toFixed(2)}ms
                  </span>
                </div>
                {includeRowData && (
                  <div>
                    <span className="text-blue-600 dark:text-blue-400">Total Rows:</span>
                    <span className="ml-2 font-medium">
                      {integratedTrace.reduce((sum, t) => sum + t.rowData.length, 0)}
                    </span>
                  </div>
                )}
                <div>
                  <span className="text-blue-600 dark:text-blue-400">With Errors:</span>
                  <span className="ml-2 font-medium">
                    {integratedTrace.filter(t => t.traceRow?.error_message).length}
                  </span>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-gray-500 dark:text-gray-400">
            <div className="text-center">
              <Activity size={48} className="mx-auto mb-4 text-gray-400 dark:text-gray-500" />
              <p className="mb-4">Click "Trace Execution" to see instruction flow with data</p>
              <p className="text-sm text-gray-400 dark:text-gray-500">
                Shows instruction dependencies, input values, relative timing, and optional row-level data
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
