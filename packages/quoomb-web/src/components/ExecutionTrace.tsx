import React, { useState } from 'react';
import { useSessionStore } from '../stores/sessionStore.js';
import { Play, AlertTriangle, Activity, Loader, Copy, Check, Info, ChevronDown, ChevronRight, ArrowRight } from 'lucide-react';

export const ExecutionTrace: React.FC = () => {
  const { queryHistory, activeResultId, fetchTrace } = useSessionStore();
  const [isLoadingTrace, setIsLoadingTrace] = useState(false);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [copySuccess, setCopySuccess] = useState(false);
  const [showQuery, setShowQuery] = useState(false);
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set());

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

  const toggleEventExpansion = (eventId: string) => {
    const newExpanded = new Set(expandedEvents);
    if (newExpanded.has(eventId)) {
      newExpanded.delete(eventId);
    } else {
      newExpanded.add(eventId);
    }
    setExpandedEvents(newExpanded);
  };

  // Build a dependency-aware instruction flow
  const buildInstructionFlow = (traceData: any[]) => {
    // Now each row is already a complete instruction execution
    const instructionInfo = new Map<number, { dependencies: number[], operation: string }>();

    traceData.forEach(row => {
      const instrIndex = (row.instruction_index as number) || 0;
      const dependencies = row.dependencies ? JSON.parse(row.dependencies as string) : [];
      const operation = (row.operation as string) || 'Unknown';
      instructionInfo.set(instrIndex, { dependencies, operation });
    });

    // Topological sort to order instructions by dependency
    const instructionIndexes = Array.from(instructionInfo.keys()).sort((a, b) => a - b);
    const visited = new Set<number>();
    const visiting = new Set<number>();
    const result: number[] = [];

    const visit = (instrIndex: number) => {
      if (visiting.has(instrIndex)) {
        // Circular dependency - just add it to avoid infinite loop
        return;
      }
      if (visited.has(instrIndex)) {
        return;
      }

      visiting.add(instrIndex);
      const info = instructionInfo.get(instrIndex);
      if (info) {
        // Visit dependencies first
        info.dependencies.forEach(depIndex => {
          if (instructionInfo.has(depIndex)) {
            visit(depIndex);
          }
        });
      }
      visiting.delete(instrIndex);
      visited.add(instrIndex);
      result.push(instrIndex);
    };

    instructionIndexes.forEach(visit);

    return result.map(instrIndex => {
      const row = traceData.find(r => r.instruction_index === instrIndex);
      return {
        instructionIndex: instrIndex,
        row: row,
        dependencies: instructionInfo.get(instrIndex)?.dependencies || [],
        operation: instructionInfo.get(instrIndex)?.operation || 'Unknown'
      };
    });
  };

  const copyTraceAsText = async () => {
    if (!activeResult?.trace || activeResult.trace.length === 0) return;

    const lines = [
      `Instruction-Level Execution Trace for: ${activeResult.sql}`,
      '='.repeat(80),
      ''
    ];

    const instructionFlow = buildInstructionFlow(activeResult.trace);

    instructionFlow.forEach(({ instructionIndex, row, dependencies, operation }) => {
      lines.push(`[${instructionIndex}] ${operation}`);
      if (dependencies.length > 0) {
        lines.push(`  Depends on: [${dependencies.join(', ')}]`);
      }

      const duration = (row.duration_ms as number) || 0;
      const inputValues = (row.input_values as string) || '';
      const outputValue = (row.output_value as string) || '';
      const errorMessage = (row.error_message as string) || '';
      const subPrograms = (row.sub_programs as string) || '';

      if (duration > 0) {
        lines.push(`  Duration: ${duration.toFixed(2)}ms`);
      }
      if (inputValues) {
        lines.push(`  Input: ${inputValues}`);
      }
      if (outputValue) {
        lines.push(`  Output: ${outputValue}`);
      }
      if (subPrograms) {
        lines.push(`  Sub-programs: ${subPrograms}`);
      }
      if (errorMessage) {
        lines.push(`  Error: ${errorMessage}`);
      }
      lines.push('');
    });

    const totalDuration = activeResult.trace
      .reduce((sum, row) => sum + ((row.duration_ms as number) || 0), 0);

    lines.push(`Total Instructions: ${instructionFlow.length}`);
    lines.push(`Total Duration: ${totalDuration.toFixed(2)}ms`);

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
            Instruction-Level Trace
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
              Instruction Dependency Flow ({activeResult.trace.length} traced events):
            </h4>

            {activeResult.trace.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                <p>No execution trace data available</p>
              </div>
            ) : (
              <div className="space-y-4">
                {/* Dependency-ordered instruction flow */}
                {buildInstructionFlow(activeResult.trace).map(({ instructionIndex, row, dependencies, operation }, flowIndex, flowArray) => {
                  const eventId = `instruction-${instructionIndex}`;
                  const isExpanded = expandedEvents.has(eventId);

                  // Get data from the single instruction row
                  const duration = (row.duration_ms as number) || 0;
                  const inputValues = (row.input_values as string) || '';
                  const outputValue = (row.output_value as string) || '';
                  const errorMessage = (row.error_message as string) || '';
                  const subPrograms = (row.sub_programs as string) || '';
                  const timestamp = new Date(row.timestamp_ms as number).toLocaleTimeString();

                  return (
                    <div key={instructionIndex} className="relative">
                      {/* Flow connector from previous instruction */}
                      {flowIndex > 0 && dependencies.length > 0 && (
                        <div className="flex items-center justify-center mb-2">
                          <div className="flex items-center gap-2 text-gray-400 dark:text-gray-500">
                            <div className="h-px bg-gray-300 dark:bg-gray-600 w-8"></div>
                            <ArrowRight size={14} />
                            <div className="h-px bg-gray-300 dark:bg-gray-600 w-8"></div>
                          </div>
                        </div>
                      )}

                      <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                        {/* Instruction header with dependencies */}
                        <button
                          onClick={() => toggleEventExpansion(eventId)}
                          className="w-full flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-750 transition-colors text-left"
                        >
                          {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                          <div className="flex-1">
                            <div className="flex items-center gap-3 flex-wrap">
                              <span className="font-mono text-sm text-blue-600 dark:text-blue-400">
                                [{instructionIndex}]
                              </span>
                              <span className="font-medium text-gray-900 dark:text-white">
                                {operation}
                              </span>
                              {duration > 0 && (
                                <span className="text-sm text-gray-500 dark:text-gray-400">
                                  ({duration.toFixed(2)}ms)
                                </span>
                              )}
                              {dependencies.length > 0 && (
                                <div className="flex items-center gap-1 text-xs">
                                  <span className="text-gray-500 dark:text-gray-400">depends on:</span>
                                  {dependencies.map((dep, i) => (
                                    <span key={dep} className="text-orange-600 dark:text-orange-400 font-mono">
                                      [{dep}]{i < dependencies.length - 1 ? ',' : ''}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                            <div className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                              Executed at {timestamp}
                            </div>
                          </div>
                        </button>

                        {/* Expanded instruction details */}
                        {isExpanded && (
                          <div className="p-3 space-y-3 bg-white dark:bg-gray-900">
                            {/* Input values */}
                            {inputValues && (
                              <div className="border-l-2 border-blue-200 dark:border-blue-700 pl-3">
                                <div className="text-xs font-medium text-blue-600 dark:text-blue-400 mb-1">
                                  Input Values:
                                </div>
                                <div className="bg-blue-50 dark:bg-blue-900/20 rounded p-2 text-xs font-mono">
                                  <pre className="whitespace-pre-wrap break-words">{inputValues}</pre>
                                </div>
                              </div>
                            )}

                            {/* Output value */}
                            {outputValue && (
                              <div className="border-l-2 border-green-200 dark:border-green-700 pl-3">
                                <div className="text-xs font-medium text-green-600 dark:text-green-400 mb-1">
                                  Output Value:
                                </div>
                                <div className="bg-green-50 dark:bg-green-900/20 rounded p-2 text-xs font-mono">
                                  <pre className="whitespace-pre-wrap break-words">{outputValue}</pre>
                                </div>
                              </div>
                            )}

                            {/* Sub-programs */}
                            {subPrograms && (
                              <div className="border-l-2 border-purple-200 dark:border-purple-700 pl-3">
                                <div className="text-xs font-medium text-purple-600 dark:text-purple-400 mb-1">
                                  Sub-Programs:
                                </div>
                                <div className="bg-purple-50 dark:bg-purple-900/20 rounded p-2 text-xs font-mono">
                                  <pre className="whitespace-pre-wrap break-words">{subPrograms}</pre>
                                </div>
                              </div>
                            )}

                            {/* Error message */}
                            {errorMessage && (
                              <div className="border-l-2 border-red-200 dark:border-red-700 pl-3">
                                <div className="text-xs font-medium text-red-600 dark:text-red-400 mb-1">
                                  Error:
                                </div>
                                <div className="bg-red-50 dark:bg-red-900/20 rounded p-2 text-xs font-mono text-red-700 dark:text-red-300">
                                  {errorMessage}
                                </div>
                              </div>
                            )}

                            {/* Execution summary */}
                            <div className="border-l-2 border-gray-200 dark:border-gray-700 pl-3">
                              <div className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                                Execution Summary:
                              </div>
                              <div className="text-xs text-gray-500 dark:text-gray-400 space-y-1">
                                <div>Duration: {duration > 0 ? `${duration.toFixed(2)}ms` : 'Instant'}</div>
                                <div>Dependencies: {dependencies.length > 0 ? `[${dependencies.join(', ')}]` : 'None'}</div>
                                <div>Timestamp: {timestamp}</div>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}

                {/* Trace statistics */}
                <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
                  <h5 className="text-sm font-medium text-blue-800 dark:text-blue-200 mb-2">
                    Execution Statistics
                  </h5>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                    <div>
                      <span className="text-blue-600 dark:text-blue-400">Instructions:</span>
                      <span className="ml-2 font-medium">
                        {activeResult.trace.length}
                      </span>
                    </div>
                    <div>
                      <span className="text-blue-600 dark:text-blue-400">Total Duration:</span>
                      <span className="ml-2 font-medium">
                        {activeResult.trace.reduce((sum, row) => sum + ((row.duration_ms as number) || 0), 0).toFixed(2)}ms
                      </span>
                    </div>
                    <div>
                      <span className="text-blue-600 dark:text-blue-400">With Sub-programs:</span>
                      <span className="ml-2 font-medium">
                        {activeResult.trace.filter(row => row.sub_programs).length}
                      </span>
                    </div>
                    <div>
                      <span className="text-blue-600 dark:text-blue-400">With Errors:</span>
                      <span className="ml-2 font-medium">
                        {activeResult.trace.filter(row => row.error_message).length}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Trace explanation */}
                <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
                  <h5 className="text-sm font-medium text-green-800 dark:text-green-200 mb-2">
                    Understanding Dependency Flow
                  </h5>
                  <div className="text-sm text-green-700 dark:text-green-300 space-y-1">
                    <p>• Instructions are ordered by dependency flow - dependencies execute first</p>
                    <p>• Each instruction shows which previous instructions it depends on</p>
                    <p>• INPUT events show values passed from dependent instructions</p>
                    <p>• OUTPUT events show values produced for subsequent instructions</p>
                    <p>• This reveals the actual data flow through the query execution engine</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-gray-500 dark:text-gray-400">
            <div className="text-center">
              <Activity size={48} className="mx-auto mb-4 text-gray-400 dark:text-gray-500" />
              <p className="mb-4">Click "Trace Execution" to see instruction-level dependency flow</p>
              <p className="text-sm text-gray-400 dark:text-gray-500">
                Shows how data flows between instructions with actual input/output values
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
