import React, { useState } from 'react';
import { useSessionStore } from '../stores/sessionStore.js';
import { Play, AlertTriangle, FileText, Loader, Copy, Check, ChevronRight, ChevronDown } from 'lucide-react';

export const QueryProgram: React.FC = () => {
  const { queryHistory, activeResultId, fetchProgram } = useSessionStore();
  const [isLoadingProgram, setIsLoadingProgram] = useState(false);
  const [programError, setProgramError] = useState<string | null>(null);
  const [expandedInstructions, setExpandedInstructions] = useState<Set<number>>(new Set());
  const [copySuccess, setCopySuccess] = useState(false);

  const activeResult = queryHistory.find(result => result.id === activeResultId);

  const handleFetchProgram = async () => {
    if (!activeResult) return;

    setIsLoadingProgram(true);
    setProgramError(null);

    try {
      await fetchProgram(activeResult.sql);
    } catch (error) {
      setProgramError(error instanceof Error ? error.message : 'Failed to fetch query program');
    } finally {
      setIsLoadingProgram(false);
    }
  };

  const copyProgramAsText = async () => {
    if (!activeResult?.program || activeResult.program.length === 0) return;

    // Build text representation of the program
    const instructions = activeResult.program.map(row => ({
      addr: row.addr as number,
      instructionId: row.instruction_id as string,
      dependencies: row.dependencies as string,
      description: row.description as string,
      estimatedCost: row.estimated_cost as number | null,
      isSubprogram: row.is_subprogram as number,
      parentAddr: row.parent_addr as number | null,
    }));

    instructions.sort((a, b) => a.addr - b.addr);

    const lines = [
      `Query Program for: ${activeResult.sql}`,
      '='.repeat(80),
      ''
    ];

    instructions.forEach(instr => {
      const prefix = instr.isSubprogram ? '  SUB: ' : '';
      lines.push(`${prefix}[${instr.addr}] ${instr.instructionId}`);
      lines.push(`  ${instr.description}`);
      if (instr.dependencies && instr.dependencies !== '[]') {
        lines.push(`  Dependencies: ${instr.dependencies}`);
      }
      if (instr.estimatedCost !== null) {
        lines.push(`  Cost: ${instr.estimatedCost}`);
      }
      lines.push('');
    });

    lines.push(`Total Instructions: ${instructions.length}`);

    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch (error) {
      console.error('Failed to copy program to clipboard:', error);
    }
  };

  const toggleInstructionExpansion = (addr: number) => {
    const newExpanded = new Set(expandedInstructions);
    if (newExpanded.has(addr)) {
      newExpanded.delete(addr);
    } else {
      newExpanded.add(addr);
    }
    setExpandedInstructions(newExpanded);
  };

  const renderProgramTable = () => {
    if (!activeResult?.program || activeResult.program.length === 0) {
      return null;
    }

    // Build instruction list from the flat program data
    const instructions = activeResult.program.map(row => ({
      addr: row.addr as number,
      instructionId: row.instruction_id as string,
      dependencies: row.dependencies as string,
      description: row.description as string,
      estimatedCost: row.estimated_cost as number | null,
      isSubprogram: row.is_subprogram as number,
      parentAddr: row.parent_addr as number | null,
    }));

    // Sort by address
    instructions.sort((a, b) => a.addr - b.addr);

    // Group by main program vs subprograms
    const mainInstructions = instructions.filter(i => !i.isSubprogram);
    const subInstructions = instructions.filter(i => i.isSubprogram);

    return (
      <div className="space-y-3">
        {/* Main program */}
        <div>
          <h5 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Main Program ({mainInstructions.length} instructions):
          </h5>
          <div className="space-y-1">
            {mainInstructions.map((instr) => {
              const isExpanded = expandedInstructions.has(instr.addr);
              const hasDetails = instr.dependencies !== '[]' || instr.estimatedCost !== null;

              return (
                <div key={instr.addr} className="border border-gray-200 dark:border-gray-700 rounded">
                  {/* Instruction header */}
                  <div
                    className={`flex items-center justify-between p-2 ${hasDetails ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700' : ''}`}
                    onClick={() => hasDetails && toggleInstructionExpansion(instr.addr)}
                  >
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      {hasDetails && (
                        <div className="flex-shrink-0">
                          {isExpanded ? (
                            <ChevronDown size={14} className="text-gray-400" />
                          ) : (
                            <ChevronRight size={14} className="text-gray-400" />
                          )}
                        </div>
                      )}

                      <span className="text-xs font-mono bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded text-gray-600 dark:text-gray-300">
                        #{instr.addr}
                      </span>

                      <span className="font-medium text-blue-600 dark:text-blue-400 text-sm">
                        {instr.instructionId}
                      </span>

                      <span className="text-sm text-gray-600 dark:text-gray-400 truncate">
                        {instr.description}
                      </span>
                    </div>

                    {instr.estimatedCost !== null && (
                      <span className="text-xs text-gray-500 dark:text-gray-400 ml-2 flex-shrink-0">
                        {instr.estimatedCost}
                      </span>
                    )}
                  </div>

                  {/* Expanded details */}
                  {isExpanded && hasDetails && (
                    <div className="border-t border-gray-200 dark:border-gray-700 px-2 py-2 bg-gray-50 dark:bg-gray-800">
                      {instr.dependencies && instr.dependencies !== '[]' && (
                        <div className="mb-1">
                          <span className="text-xs font-medium text-gray-600 dark:text-gray-400">Dependencies: </span>
                          <span className="text-xs font-mono text-gray-700 dark:text-gray-300">{instr.dependencies}</span>
                        </div>
                      )}
                      {instr.estimatedCost !== null && (
                        <div>
                          <span className="text-xs font-medium text-gray-600 dark:text-gray-400">Cost: </span>
                          <span className="text-xs text-gray-700 dark:text-gray-300">{instr.estimatedCost}</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Subprograms */}
        {subInstructions.length > 0 && (
          <div>
            <h5 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Subprograms ({subInstructions.length} instructions):
            </h5>
            <div className="space-y-1 pl-3 border-l-2 border-orange-300 dark:border-orange-600">
              {subInstructions.map((instr) => {
                const isExpanded = expandedInstructions.has(instr.addr);
                const hasDetails = instr.dependencies !== '[]' || instr.estimatedCost !== null;

                return (
                  <div key={instr.addr} className="border border-orange-200 dark:border-orange-700 rounded">
                    {/* Instruction header */}
                    <div
                      className={`flex items-center justify-between p-2 ${hasDetails ? 'cursor-pointer hover:bg-orange-50 dark:hover:bg-orange-900/20' : ''}`}
                      onClick={() => hasDetails && toggleInstructionExpansion(instr.addr)}
                    >
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        {hasDetails && (
                          <div className="flex-shrink-0">
                            {isExpanded ? (
                              <ChevronDown size={14} className="text-gray-400" />
                            ) : (
                              <ChevronRight size={14} className="text-gray-400" />
                            )}
                          </div>
                        )}

                        <span className="text-xs font-mono bg-orange-100 dark:bg-orange-900 px-1.5 py-0.5 rounded text-orange-700 dark:text-orange-300">
                          #{instr.addr}
                        </span>

                        <span className="font-medium text-orange-600 dark:text-orange-400 text-sm">
                          {instr.instructionId}
                        </span>

                        {instr.parentAddr !== null && (
                          <span className="text-xs text-gray-500 dark:text-gray-400">
                            ↳#{instr.parentAddr}
                          </span>
                        )}

                        <span className="text-sm text-gray-600 dark:text-gray-400 truncate">
                          {instr.description}
                        </span>
                      </div>

                      {instr.estimatedCost !== null && (
                        <span className="text-xs text-gray-500 dark:text-gray-400 ml-2 flex-shrink-0">
                          {instr.estimatedCost}
                        </span>
                      )}
                    </div>

                    {/* Expanded details */}
                    {isExpanded && hasDetails && (
                      <div className="border-t border-orange-200 dark:border-orange-700 px-2 py-2 bg-orange-50 dark:bg-orange-900/20">
                        {instr.dependencies && instr.dependencies !== '[]' && (
                          <div className="mb-1">
                            <span className="text-xs font-medium text-gray-600 dark:text-gray-400">Dependencies: </span>
                            <span className="text-xs font-mono text-gray-700 dark:text-gray-300">{instr.dependencies}</span>
                          </div>
                        )}
                        {instr.estimatedCost !== null && (
                          <div>
                            <span className="text-xs font-medium text-gray-600 dark:text-gray-400">Cost: </span>
                            <span className="text-xs text-gray-700 dark:text-gray-300">{instr.estimatedCost}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  };

  if (!activeResult) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        <div className="text-center">
          <FileText size={48} className="mx-auto mb-4 text-gray-400" />
          <p>No query selected for program analysis</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
          Query Program
        </h3>

        <div className="flex items-center gap-2">
          {activeResult.program && (
            <button
              onClick={copyProgramAsText}
              className="flex items-center gap-1 px-2 py-1 text-xs bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 rounded transition-colors"
              title="Copy program as text"
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
            onClick={handleFetchProgram}
            disabled={isLoadingProgram}
            className="flex items-center gap-2 px-3 py-1 text-sm bg-blue-500 hover:bg-blue-600 disabled:bg-gray-400 text-white rounded transition-colors"
          >
            {isLoadingProgram ? (
              <Loader size={16} className="animate-spin" />
            ) : (
              <Play size={16} />
            )}
            {isLoadingProgram ? 'Analyzing...' : 'Analyze Program'}
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
      {programError && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <div className="flex items-center gap-2 text-red-700 dark:text-red-300">
            <AlertTriangle size={16} />
            <span className="text-sm font-medium">Program Analysis Failed</span>
          </div>
          <p className="text-sm text-red-600 dark:text-red-400 mt-1">{programError}</p>
        </div>
      )}

      {/* Program display */}
      <div className="flex-1 overflow-auto">
        {activeResult.program ? (
          <div>
            <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
              Compiled Program ({activeResult.program.length} instructions):
            </h4>

            {activeResult.program.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                <p>No program information available</p>
              </div>
            ) : (
              <div className="space-y-4">
                {renderProgramTable()}

                {/* Program explanation */}
                <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 mt-4">
                  <h5 className="text-sm font-medium text-blue-800 dark:text-blue-200 mb-2">
                    Program Reading Guide
                  </h5>
                  <div className="text-sm text-blue-700 dark:text-blue-300 space-y-1">
                    <p>• Instructions are executed by address in ascending order</p>
                    <p>• Dependencies show which instructions must complete first</p>
                    <p>• Subprograms are executed within their parent instruction</p>
                    <p>• Orange badges indicate subprogram instructions</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-gray-500">
            <div className="text-center">
              <FileText size={48} className="mx-auto mb-4 text-gray-400" />
              <p className="mb-4">Click "Analyze Program" to see the compiled instruction program</p>
              <p className="text-sm text-gray-400">
                Shows how your SQL gets compiled into executable instructions
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
