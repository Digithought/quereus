import React, { useState, useRef, useCallback, useMemo } from 'react';
import { useSessionStore } from '../stores/sessionStore.js';
import { Play, ZoomIn, ZoomOut, RotateCcw, Eye, Activity, Copy, Check } from 'lucide-react';
import type { PlanGraphNode, PlanGraph } from '../worker/types.js';

interface TreeLayout {
  x: number;
  y: number;
  node: PlanGraphNode;
}

interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

export const QueryPlanGraph: React.FC = () => {
  const { queryHistory, activeResultId, fetchPlanGraph, setSelectedNodeId, setPlanMode } = useSessionStore();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewBox, setViewBox] = useState<ViewBox>({ x: 0, y: 0, width: 800, height: 600, scale: 1 });
  const [copySuccess, setCopySuccess] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [lastMousePos, setLastMousePos] = useState({ x: 0, y: 0 });
  const svgRef = useRef<SVGSVGElement>(null);

  const activeResult = queryHistory.find(result => result.id === activeResultId);
  const planGraph = activeResult?.planGraph;
  const planMode = activeResult?.planMode || 'estimated';
  const selectedNodeId = activeResult?.selectedNodeId;

  // Simple tree layout algorithm (Reingold-Tilford style)
  const layoutTree = useCallback((root: PlanGraphNode): TreeLayout[] => {
    const layouts: TreeLayout[] = [];
    const nodeWidth = 160;
    const nodeHeight = 80;
    const levelHeight = 120;
    const nodeSpacing = 40;

    const traverse = (node: PlanGraphNode, depth: number, siblingIndex: number, siblingsCount: number) => {
      // Center nodes better by using wider spacing
      const x = (siblingIndex - (siblingsCount - 1) / 2) * (nodeWidth + nodeSpacing);
      const y = depth * levelHeight + 50; // Add top margin

      layouts.push({ x, y, node });

      // Layout children
      node.children.forEach((child, index) => {
        traverse(child, depth + 1, index, node.children.length);
      });
    };

    if (root) {
      traverse(root, 0, 0, 1);
    }

    return layouts;
  }, []);

  // Calculate content bounds
  const getContentBounds = useCallback((layouts: TreeLayout[]) => {
    if (layouts.length === 0) {
      return { minX: 0, maxX: 800, minY: 0, maxY: 600 };
    }

    const nodeWidth = 160;
    const nodeHeight = 80;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

    layouts.forEach(layout => {
      minX = Math.min(minX, layout.x - nodeWidth / 2);
      maxX = Math.max(maxX, layout.x + nodeWidth / 2);
      minY = Math.min(minY, layout.y - nodeHeight / 2);
      maxY = Math.max(maxY, layout.y + nodeHeight / 2);
    });

    // Add padding
    const padding = 50;
    return {
      minX: minX - padding,
      maxX: maxX + padding,
      minY: minY - padding,
      maxY: maxY + padding
    };
  }, []);

  // Auto-fit viewBox to content
  const autoFitContent = useCallback((layouts: TreeLayout[]) => {
    const bounds = getContentBounds(layouts);
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;

    setViewBox({
      x: bounds.minX,
      y: bounds.minY,
      width,
      height,
      scale: 1
    });
  }, [getContentBounds]);

  // Calculate hotspot score for a node
  const getHotspotScore = useCallback((node: PlanGraphNode, totals: PlanGraph['totals']): number => {
    const timeOrCost = node.actTimeMs ?? node.estCost;
    const totalTimeOrCost = totals.actTimeMs ?? totals.estCost;

    if (totalTimeOrCost === 0) return 0;
    return Math.min(1, timeOrCost / totalTimeOrCost);
  }, []);

  // Get color based on hotspot score
  const getNodeColor = useCallback((score: number): string => {
    if (score < 0.1) return '#e5f3ff'; // Very light blue
    if (score < 0.3) return '#fef3c7'; // Light yellow
    if (score < 0.6) return '#fed7aa'; // Light orange
    if (score < 0.8) return '#fecaca'; // Light red
    return '#fca5a5'; // Red
  }, []);

  const getNodeBorderColor = useCallback((score: number): string => {
    if (score < 0.1) return '#3b82f6'; // Blue
    if (score < 0.3) return '#f59e0b'; // Yellow
    if (score < 0.6) return '#f97316'; // Orange
    if (score < 0.8) return '#ef4444'; // Red
    return '#dc2626'; // Dark red
  }, []);

  const layouts = useMemo(() => {
    const newLayouts = planGraph ? layoutTree(planGraph.root) : [];

    // Auto-fit when new plan is loaded
    if (newLayouts.length > 0) {
      setTimeout(() => autoFitContent(newLayouts), 0);
    }

    return newLayouts;
  }, [planGraph, layoutTree, autoFitContent]);

  // Mouse event handlers for panning
  const handleMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (e.button === 0) { // Left mouse button
      setIsDragging(true);
      setLastMousePos({ x: e.clientX, y: e.clientY });
      e.preventDefault();
    }
  };

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!isDragging) return;

    const deltaX = e.clientX - lastMousePos.x;
    const deltaY = e.clientY - lastMousePos.y;

    setViewBox(prev => ({
      ...prev,
      x: prev.x - deltaX / prev.scale,
      y: prev.y - deltaY / prev.scale
    }));

    setLastMousePos({ x: e.clientX, y: e.clientY });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();

    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;

    // Get mouse position relative to SVG element
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Convert screen coordinates to SVG world coordinates
    const currentViewWidth = viewBox.width / viewBox.scale;
    const currentViewHeight = viewBox.height / viewBox.scale;
    const svgMouseX = viewBox.x + (mouseX / rect.width) * currentViewWidth;
    const svgMouseY = viewBox.y + (mouseY / rect.height) * currentViewHeight;

    // Calculate new scale
    const scaleFactor = e.deltaY > 0 ? 0.8 : 1.25; // More pronounced zoom steps
    const newScale = Math.max(0.1, Math.min(5, viewBox.scale * scaleFactor));

    if (newScale === viewBox.scale) return; // No change needed

    // Calculate new view dimensions
    const newViewWidth = viewBox.width / newScale;
    const newViewHeight = viewBox.height / newScale;

    // Calculate new viewBox position to keep mouse point stationary
    const mouseXRatio = mouseX / rect.width;
    const mouseYRatio = mouseY / rect.height;

    const newX = svgMouseX - mouseXRatio * newViewWidth;
    const newY = svgMouseY - mouseYRatio * newViewHeight;

    setViewBox(prev => ({
      ...prev,
      x: newX,
      y: newY,
      scale: newScale
    }));
  };

  const handleZoom = (factor: number) => {
    setViewBox(prev => {
      const newScale = Math.max(0.1, Math.min(5, prev.scale * factor));
      const scaleRatio = newScale / prev.scale;

      // Zoom towards center
      const centerX = prev.x + prev.width / (2 * prev.scale);
      const centerY = prev.y + prev.height / (2 * prev.scale);

      return {
        ...prev,
        x: centerX - (centerX - prev.x) * scaleRatio,
        y: centerY - (centerY - prev.y) * scaleRatio,
        scale: newScale
      };
    });
  };

  const handleReset = () => {
    if (layouts.length > 0) {
      autoFitContent(layouts);
    } else {
      setViewBox({ x: 0, y: 0, width: 800, height: 600, scale: 1 });
    }
    setSelectedNodeId(undefined);
  };

  const handleFetchPlan = async (withActual: boolean) => {
    if (!activeResult) return;

    setIsLoading(true);
    setError(null);

    try {
      await fetchPlanGraph(activeResult.sql, withActual);
      setPlanMode(withActual ? 'actual' : 'estimated');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch plan graph');
    } finally {
      setIsLoading(false);
    }
  };

  const handleNodeClick = (node: PlanGraphNode) => {
    setSelectedNodeId(selectedNodeId === node.id ? undefined : node.id);
  };

  const copyPlanAsText = async () => {
    if (!planGraph) return;

    const lines = [`Query Plan (${planMode})`, '='.repeat(40), ''];

    const traverse = (node: PlanGraphNode, depth: number) => {
      const indent = '  '.repeat(depth);
      const timeInfo = node.actTimeMs ? ` (${node.actTimeMs.toFixed(1)}ms)` : '';
      const rowInfo = node.actRows ? ` [${node.actRows} rows]` : ` [~${node.estRows} rows]`;
      lines.push(`${indent}${node.opcode}${timeInfo}${rowInfo}`);

      if (node.extra?.detail) {
        lines.push(`${indent}  ${node.extra.detail}`);
      }

      node.children.forEach(child => traverse(child, depth + 1));
    };

    traverse(planGraph.root, 0);

    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch (error) {
      console.error('Failed to copy plan to clipboard:', error);
    }
  };

  if (!activeResult) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        <div className="text-center">
          <Eye size={48} className="mx-auto mb-4 text-gray-400" />
          <p>No query selected for plan visualization</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
          Query Plan Graph
        </h3>

        <div className="flex items-center gap-2">
          {/* Plan mode toggle */}
          <div className="flex items-center bg-gray-100 dark:bg-gray-700 rounded-lg p-1">
            <button
              onClick={() => handleFetchPlan(false)}
              className={`px-3 py-1 text-sm rounded-md transition-colors ${
                planMode === 'estimated'
                  ? 'bg-white dark:bg-gray-600 text-gray-900 dark:text-white shadow'
                  : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
              }`}
            >
              Estimated
            </button>
            <button
              onClick={() => handleFetchPlan(true)}
              className={`px-3 py-1 text-sm rounded-md transition-colors ${
                planMode === 'actual'
                  ? 'bg-white dark:bg-gray-600 text-gray-900 dark:text-white shadow'
                  : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
              }`}
            >
              <Activity size={12} className="inline mr-1" />
              Actual
            </button>
          </div>

          {/* Zoom controls */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => handleZoom(1.2)}
              className="p-1 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
              title="Zoom in"
            >
              <ZoomIn size={16} />
            </button>
            <button
              onClick={() => handleZoom(0.8)}
              className="p-1 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
              title="Zoom out"
            >
              <ZoomOut size={16} />
            </button>
            <button
              onClick={handleReset}
              className="p-1 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
              title="Reset view"
            >
              <RotateCcw size={16} />
            </button>
          </div>

          {/* Copy button */}
          {planGraph && (
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

          {/* Fetch button */}
          <button
            onClick={() => handleFetchPlan(planMode === 'actual')}
            disabled={isLoading}
            className="flex items-center gap-2 px-3 py-1 text-sm bg-blue-500 hover:bg-blue-600 disabled:bg-gray-400 text-white rounded transition-colors"
          >
            <Play size={16} />
            {isLoading ? 'Loading...' : 'Visualize'}
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
      {error && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        </div>
      )}

      {/* SVG Graph */}
      <div className="flex-1 overflow-hidden border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900">
        {planGraph ? (
          <svg
            ref={svgRef}
            className={`w-full h-full ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
            viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width / viewBox.scale} ${viewBox.height / viewBox.scale}`}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onWheel={handleWheel}
          >
            {/* Connections */}
            {layouts.map(layout =>
              layout.node.children.map(child => {
                const childLayout = layouts.find(l => l.node.id === child.id);
                if (!childLayout) return null;

                return (
                  <line
                    key={`${layout.node.id}-${child.id}`}
                    x1={layout.x}
                    y1={layout.y + 40}
                    x2={childLayout.x}
                    y2={childLayout.y - 40}
                    stroke="#94a3b8"
                    strokeWidth="2"
                  />
                );
              })
            )}

            {/* Nodes */}
            {layouts.map(layout => {
              const score = getHotspotScore(layout.node, planGraph.totals);
              const isSelected = selectedNodeId === layout.node.id;

              return (
                <g key={layout.node.id}>
                  {/* Node background */}
                  <rect
                    x={layout.x - 80}
                    y={layout.y - 40}
                    width={160}
                    height={80}
                    fill={getNodeColor(score)}
                    stroke={isSelected ? '#3b82f6' : getNodeBorderColor(score)}
                    strokeWidth={isSelected ? 3 : 2}
                    rx={8}
                    className="cursor-pointer hover:stroke-blue-500"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleNodeClick(layout.node);
                    }}
                  />

                  {/* Node text */}
                  <text
                    x={layout.x}
                    y={layout.y - 15}
                    textAnchor="middle"
                    className="text-sm font-medium fill-gray-900 dark:fill-gray-100 pointer-events-none"
                  >
                    {layout.node.opcode}
                  </text>

                  {/* Stats */}
                  <text
                    x={layout.x}
                    y={layout.y}
                    textAnchor="middle"
                    className="text-xs fill-gray-600 dark:fill-gray-400 pointer-events-none"
                  >
                    {layout.node.actRows ?? layout.node.estRows} rows
                  </text>

                  {/* Time/Cost */}
                  <text
                    x={layout.x}
                    y={layout.y + 15}
                    textAnchor="middle"
                    className="text-xs fill-gray-600 dark:fill-gray-400 pointer-events-none"
                  >
                    {layout.node.actTimeMs ? `${layout.node.actTimeMs.toFixed(1)}ms` : `cost: ${layout.node.estCost}`}
                  </text>
                </g>
              );
            })}
          </svg>
        ) : (
          <div className="flex items-center justify-center h-full text-gray-500">
            <div className="text-center">
              <Eye size={48} className="mx-auto mb-4 text-gray-400" />
              <p className="mb-4">Click "Visualize" to see the query plan graph</p>
              <p className="text-sm text-gray-400">
                Visual representation of query execution with hotspot analysis
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Legend */}
      {planGraph && (
        <div className="mt-2 p-2 bg-gray-50 dark:bg-gray-800 rounded text-xs text-gray-600 dark:text-gray-400">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-4">
              <span>Hotspots:</span>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 bg-blue-100 border border-blue-400 rounded"></div>
                <span>Low</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 bg-yellow-200 border border-yellow-500 rounded"></div>
                <span>Medium</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 bg-red-200 border border-red-500 rounded"></div>
                <span>High</span>
              </div>
            </div>
            <span className="border-l border-gray-300 dark:border-gray-600 pl-4">
              Click nodes to select • Drag to pan • Scroll to zoom • Use controls to reset
            </span>
          </div>
        </div>
      )}
    </div>
  );
};
