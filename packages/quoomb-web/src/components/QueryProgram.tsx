import React, { useState } from 'react';
import { useSessionStore } from '../stores/sessionStore.js';
import { Play, AlertTriangle, Code, Loader, Copy, Check, Info } from 'lucide-react';

export const QueryProgram: React.FC = () => {
  const { queryHistory, activeResultId, fetchProgram } = useSessionStore();
  const [isLoadingProgram, setIsLoadingProgram] = useState(false);
  const [programError, setProgramError] = useState<string | null>(null);
  const [copySuccess, setCopySuccess] = useState(false);
  const [showQuery, setShowQuery] = useState(false);

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

    const lines = [
      `Query Program for: ${activeResult.sql}`,
      '='.repeat(80),
      ''
    ];

    // Group instructions by operation for better readability
    const groupedInstructions = new Map<string, Array<any>>();

    activeResult.program.forEach((row, index) => {
      const description = (row.description as string) || 'UNKNOWN';
      const group = groupedInstructions.get(description) || [];
      group.push({
        index: index + 1,
        description,
        addr: row.addr,
        dependencies: row.dependencies,
        estimatedCost: row.estimated_cost as number | null,
      });
      groupedInstructions.set(description, group);
    });

    // Output grouped instructions
    for (const [description, instructions] of groupedInstructions) {
      lines.push(`${description} Operations (${instructions.length} instructions):`);
      lines.push('-'.repeat(50));

      instructions.forEach(inst => {
        lines.push(`  ${inst.addr.toString().padStart(3)}: ${inst.description}`);
        if (inst.dependencies && inst.dependencies !== '[]') {
          lines.push(`       Dependencies: ${inst.dependencies}`);
        }
        if (inst.estimatedCost !== null) {
          lines.push(`       Cost: ${inst.estimatedCost}`);
        }
      });
      lines.push('');
    }

    lines.push(`Total Instructions: ${activeResult.program.length}`);
    lines.push(`Unique Instruction Types: ${groupedInstructions.size}`);

    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch (error) {
      console.error('Failed to copy program to clipboard:', error);
    }
  };

  if (!activeResult) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 dark:text-gray-400">
        <div className="text-center">
          <Code size={48} className="mx-auto mb-4 text-gray-400 dark:text-gray-500" />
          <p>No query selected for program analysis</p>
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
            Query Program (Scheduler)
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
          {activeResult.program && (
            <button
              onClick={copyProgramAsText}
              className="p-1 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
              title="Copy program as text"
            >
              {copySuccess ? <Check size={14} /> : <Copy size={14} />}
            </button>
          )}

          <button
            onClick={handleFetchProgram}
            disabled={isLoadingProgram}
            className="flex items-center gap-1 px-2 py-1 text-xs bg-blue-500 hover:bg-blue-600 disabled:bg-gray-400 text-white rounded transition-colors"
          >
            {isLoadingProgram ? (
              <Loader size={14} className="animate-spin" />
            ) : (
              <Play size={14} />
            )}
            {isLoadingProgram ? 'Compiling...' : 'Compile Query'}
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
      {programError && (
        <div className="p-2 bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800">
          <div className="flex items-center gap-2 text-red-700 dark:text-red-300">
            <AlertTriangle size={16} />
            <span className="text-sm font-medium">Program Compilation Failed</span>
          </div>
          <p className="text-sm text-red-600 dark:text-red-400 mt-1">{programError}</p>
        </div>
      )}

      {/* Program display - takes remaining space */}
      <div className="flex-1 overflow-auto">
        {activeResult.program ? (
          <div className="p-4">
            <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
              Compiled Program ({activeResult.program.length} instructions):
            </h4>

            {activeResult.program.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                <p>No program instructions generated</p>
              </div>
            ) : (
              <div className="space-y-4">
                {/* Instruction list */}
                <div className="bg-gray-100 dark:bg-gray-800 rounded-lg overflow-hidden">
                  <div className="bg-gray-200 dark:bg-gray-700 px-4 py-2 border-b border-gray-300 dark:border-gray-600">
                    <div className="grid grid-cols-12 gap-2 text-xs font-medium text-gray-600 dark:text-gray-400">
                      <div className="col-span-1">Addr</div>
                      <div className="col-span-5">Instruction</div>
                      <div className="col-span-3">Dependencies</div>
                      <div className="col-span-3">Est. Cost</div>
                    </div>
                  </div>

                  <div className="max-h-96 overflow-y-auto">
                    {activeResult.program.map((row, index) => {
                      const addr = (row.addr as number) || index;
                      const description = (row.description as string) || 'UNKNOWN';
                      const dependencies = (row.dependencies as string) || '[]';
                      const estimatedCost = (row.estimated_cost as number) || null;

                      return (
                        <div
                          key={index}
                          className="grid grid-cols-12 gap-2 px-4 py-2 border-b border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-750 text-sm"
                        >
                          <div className="col-span-1 font-mono text-gray-500 dark:text-gray-400">
                            {addr}
                          </div>
                          <div className="col-span-5 font-mono font-medium text-blue-600 dark:text-blue-400">
                            {description}
                          </div>
                          <div className="col-span-3 text-gray-500 dark:text-gray-400 text-xs">
                            {dependencies !== '[]' ? dependencies : '—'}
                          </div>
                          <div className="col-span-3 font-mono text-gray-700 dark:text-gray-300 text-xs">
                            {estimatedCost !== null ? estimatedCost.toFixed(2) : '—'}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Program statistics */}
                <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
                  <h5 className="text-sm font-medium text-blue-800 dark:text-blue-200 mb-2">
                    Program Statistics
                  </h5>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                    <div>
                      <span className="text-blue-600 dark:text-blue-400">Total Instructions:</span>
                      <span className="ml-2 font-medium">{activeResult.program.length}</span>
                    </div>
                    <div>
                      <span className="text-blue-600 dark:text-blue-400">Unique Types:</span>
                      <span className="ml-2 font-medium">
                        {new Set(activeResult.program.map(row => row.description)).size}
                      </span>
                    </div>
                    <div>
                      <span className="text-blue-600 dark:text-blue-400">With Dependencies:</span>
                      <span className="ml-2 font-medium">
                        {activeResult.program.filter(row => row.dependencies && row.dependencies !== '[]').length}
                      </span>
                    </div>
                    <div>
                      <span className="text-blue-600 dark:text-blue-400">With Cost Estimates:</span>
                      <span className="ml-2 font-medium">
                        {activeResult.program.filter(row => row.estimated_cost !== null).length}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Program explanation */}
                <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
                  <h5 className="text-sm font-medium text-green-800 dark:text-green-200 mb-2">
                    Understanding the Program
                  </h5>
                  <div className="text-sm text-green-700 dark:text-green-300 space-y-1">
                    <p>• Each instruction is executed sequentially by the Quereus scheduler</p>
                    <p>• Instructions represent low-level database operations (scan, join, project, etc.)</p>
                    <p>• Dependencies specify other instructions that must be executed before this one</p>
                    <p>• Estimated cost provides an estimate of the time required to execute the instruction</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-gray-500 dark:text-gray-400">
            <div className="text-center">
              <Code size={48} className="mx-auto mb-4 text-gray-400 dark:text-gray-500" />
              <p className="mb-4">Click "Compile Query" to see the execution program</p>
              <p className="text-sm text-gray-400 dark:text-gray-500">
                Uses Quereus's scheduler_program() function to show compiled instructions
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
