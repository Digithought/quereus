import React, { useState } from 'react';
import { useSessionStore } from '../stores/sessionStore.js';
import { Play, AlertTriangle, FileText, Loader, ChevronRight, ChevronDown, Copy, Check } from 'lucide-react';

export const QueryPlan: React.FC = () => {
  const { queryHistory, activeResultId, fetchQueryPlan } = useSessionStore();
  const [isLoadingPlan, setIsLoadingPlan] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [expandedNodes, setExpandedNodes] = useState<Set<number>>(new Set());
  const [copySuccess, setCopySuccess] = useState(false);

  const activeResult = queryHistory.find(result => result.id === activeResultId);

  const handleFetchPlan = async () => {
    if (!activeResult) return;

    setIsLoadingPlan(true);
    setPlanError(null);

    try {
      await fetchQueryPlan(activeResult.sql);
    } catch (error) {
      setPlanError(error instanceof Error ? error.message : 'Failed to fetch query plan');
    } finally {
      setIsLoadingPlan(false);
    }
  };

  const copyPlanAsText = async () => {
    if (!activeResult?.queryPlan || activeResult.queryPlan.length === 0) return;

    // Build text representation of the plan
    const planNodes = activeResult.queryPlan.map(row => ({
      id: row.id as number,
      parentId: row.parent_id as number | null,
      nodeType: row.node_type as string,
      op: row.op as string,
      detail: row.detail as string,
      objectName: row.object_name as string | null,
      estCost: row.est_cost as number | null,
      estRows: row.est_rows as number | null,
    }));

    planNodes.sort((a, b) => a.id - b.id);

    const lines = [
      `Query Execution Plan for: ${activeResult.sql}`,
      '='.repeat(80),
      ''
    ];

    planNodes.forEach(node => {
      lines.push(`#${node.id} ${node.op}${node.objectName ? ` (${node.objectName})` : ''}`);
      lines.push(`  ${node.detail}`);
      if (node.estCost !== null || node.estRows !== null) {
        const estimates = [];
        if (node.estCost !== null) estimates.push(`Cost: ${node.estCost.toFixed(1)}`);
        if (node.estRows !== null) estimates.push(`Rows: ${node.estRows.toLocaleString()}`);
        lines.push(`  ${estimates.join(', ')}`);
      }
      lines.push('');
    });

    lines.push(`Total Steps: ${planNodes.length}`);

    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch (error) {
      console.error('Failed to copy plan to clipboard:', error);
    }
  };

  const toggleNodeExpansion = (nodeId: number) => {
    const newExpanded = new Set(expandedNodes);
    if (newExpanded.has(nodeId)) {
      newExpanded.delete(nodeId);
    } else {
      newExpanded.add(nodeId);
    }
    setExpandedNodes(newExpanded);
  };

  const renderPlanTree = () => {
    if (!activeResult?.queryPlan || activeResult.queryPlan.length === 0) {
      return null;
    }

    // Build a tree structure from the flat plan data
    const planNodes = activeResult.queryPlan.map(row => ({
      id: row.id as number,
      parentId: row.parent_id as number | null,
      level: row.subquery_level as number,
      nodeType: row.node_type as string,
      op: row.op as string,
      detail: row.detail as string,
      objectName: row.object_name as string | null,
      alias: row.alias as string | null,
      properties: row.properties as string | null,
      physical: row.physical as string | null,
      estCost: row.est_cost as number | null,
      estRows: row.est_rows as number | null,
    }));

    // Sort by id to maintain tree order
    planNodes.sort((a, b) => a.id - b.id);

    return (
      <div className="space-y-2">
        {planNodes.map((node) => {
          const isExpanded = expandedNodes.has(node.id);
          const hasDetails = node.properties || node.physical || node.objectName;

          return (
            <div key={node.id} className="border border-gray-200 dark:border-gray-700 rounded-lg">
              {/* Node header */}
              <div
                className="flex items-center justify-between p-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700"
                onClick={() => hasDetails && toggleNodeExpansion(node.id)}
              >
                <div className="flex items-center gap-3">
                  {hasDetails && (
                    <div className="flex-shrink-0">
                      {isExpanded ? (
                        <ChevronDown size={16} className="text-gray-400" />
                      ) : (
                        <ChevronRight size={16} className="text-gray-400" />
                      )}
                    </div>
                  )}

                  <div className="flex-1">
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-mono bg-gray-100 dark:bg-gray-700 px-2 py-1 rounded">
                        #{node.id}
                      </span>
                      <span className="font-medium text-blue-600 dark:text-blue-400">
                        {node.op}
                      </span>
                      {node.objectName && (
                        <span className="text-sm text-gray-600 dark:text-gray-300">
                          {node.objectName}
                        </span>
                      )}
                      {node.alias && (
                        <span className="text-sm text-gray-500 dark:text-gray-400">
                          AS {node.alias}
                        </span>
                      )}
                    </div>

                    <div className="text-sm text-gray-700 dark:text-gray-300 mt-1">
                      {node.detail}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
                  {node.estCost !== null && (
                    <span>Cost: {node.estCost.toFixed(1)}</span>
                  )}
                  {node.estRows !== null && (
                    <span>Rows: {node.estRows.toLocaleString()}</span>
                  )}
                </div>
              </div>

              {/* Expanded details */}
              {isExpanded && hasDetails && (
                <div className="border-t border-gray-200 dark:border-gray-700 p-3 bg-gray-50 dark:bg-gray-800 space-y-3">
                  {node.objectName && (
                    <div>
                      <h6 className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                        Object
                      </h6>
                      <div className="text-sm font-mono bg-white dark:bg-gray-700 px-2 py-1 rounded border">
                        {node.objectName}
                      </div>
                    </div>
                  )}

                  {node.properties && (
                    <div>
                      <h6 className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                        Logical Properties
                      </h6>
                      <div className="text-xs font-mono bg-white dark:bg-gray-700 px-2 py-1 rounded border overflow-x-auto">
                        <pre className="whitespace-pre-wrap">{JSON.stringify(JSON.parse(node.properties), null, 2)}</pre>
                      </div>
                    </div>
                  )}

                  {node.physical && (
                    <div>
                      <h6 className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                        Physical Properties
                      </h6>
                      <div className="text-xs font-mono bg-white dark:bg-gray-700 px-2 py-1 rounded border overflow-x-auto">
                        <pre className="whitespace-pre-wrap">{JSON.stringify(JSON.parse(node.physical), null, 2)}</pre>
                      </div>
                    </div>
                  )}
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
          <p>No query selected for plan analysis</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
          Query Execution Plan
        </h3>

        <div className="flex items-center gap-2">
          {activeResult.queryPlan && (
            <button
              onClick={copyPlanAsText}
              className="flex items-center gap-1 px-2 py-1 text-xs bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 rounded transition-colors"
              title="Copy plan as text"
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
            onClick={handleFetchPlan}
            disabled={isLoadingPlan}
            className="flex items-center gap-2 px-3 py-1 text-sm bg-blue-500 hover:bg-blue-600 disabled:bg-gray-400 text-white rounded transition-colors"
          >
            {isLoadingPlan ? (
              <Loader size={16} className="animate-spin" />
            ) : (
              <Play size={16} />
            )}
            {isLoadingPlan ? 'Analyzing...' : 'Analyze Query'}
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
      {planError && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <div className="flex items-center gap-2 text-red-700 dark:text-red-300">
            <AlertTriangle size={16} />
            <span className="text-sm font-medium">Plan Analysis Failed</span>
          </div>
          <p className="text-sm text-red-600 dark:text-red-400 mt-1">{planError}</p>
        </div>
      )}

      {/* Plan display */}
      <div className="flex-1 overflow-auto">
        {activeResult.queryPlan ? (
          <div>
            <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
              Execution Plan ({activeResult.queryPlan.length} steps):
            </h4>

            {activeResult.queryPlan.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                <p>No plan information available</p>
              </div>
            ) : (
              <div className="space-y-4">
                {renderPlanTree()}

                {/* Plan explanation */}
                <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 mt-4">
                  <h5 className="text-sm font-medium text-blue-800 dark:text-blue-200 mb-2">
                    Plan Reading Guide
                  </h5>
                  <div className="text-sm text-blue-700 dark:text-blue-300 space-y-1">
                    <p>• Click on plan nodes to expand detailed properties</p>
                    <p>• Node IDs show execution order (lower numbers execute first)</p>
                    <p>• Cost and row estimates help identify expensive operations</p>
                    <p>• Physical properties show optimizer decisions and optimizations</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-gray-500">
            <div className="text-center">
              <FileText size={48} className="mx-auto mb-4 text-gray-400" />
              <p className="mb-4">Click "Analyze Query" to see the execution plan</p>
              <p className="text-sm text-gray-400">
                Uses Quereus's query_plan() function to show how your SQL will be executed
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
