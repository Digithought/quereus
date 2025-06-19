import React from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import type { ErrorInfo } from '@quereus/quereus';
import { useSessionStore } from '../stores/sessionStore.js';

interface EnhancedErrorDisplayProps {
  error: string;
  errorChain?: ErrorInfo[];
  selectionInfo?: {
    isSelection: boolean;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  };
  className?: string;
}

export const EnhancedErrorDisplay: React.FC<EnhancedErrorDisplayProps> = ({
  error,
  errorChain,
  selectionInfo,
  className = '',
}) => {
  const { tabs, activeTabId, setActiveTab } = useSessionStore();
  const [isExpanded, setIsExpanded] = React.useState(false);

  const navigateToError = (errorInfo: ErrorInfo) => {
    if (!errorInfo.line || !errorInfo.column || !activeTabId) return;

    // Find the active tab
    const activeTab = tabs.find(tab => tab.id === activeTabId);
    if (!activeTab) return;

    // Calculate the actual line and column in the editor
    let targetLine = errorInfo.line;
    let targetColumn = errorInfo.column;

    // If the error occurred in a selection, adjust the line/column offset
    if (selectionInfo?.isSelection) {
      targetLine = selectionInfo.startLine + errorInfo.line - 1;
      if (errorInfo.line === 1) {
        targetColumn = selectionInfo.startColumn + errorInfo.column - 1;
      }
    }

    // Use Monaco editor API to navigate to the error location
    const editorElement = document.querySelector('[data-uri*="model"]') as any;
    if (editorElement?._commandService) {
      // Try to get the Monaco editor instance
      const editor = (window as any).monaco?.editor?.getEditors()?.[0];
      if (editor) {
        editor.setPosition({ lineNumber: targetLine, column: targetColumn });
        editor.focus();
        
        // Optionally highlight the error area
        const model = editor.getModel();
        if (model) {
          const decoration = editor.deltaDecorations([], [{
            range: new (window as any).monaco.Range(targetLine, targetColumn, targetLine, targetColumn + 10),
            options: {
              isWholeLine: false,
              className: 'error-highlight',
              glyphMarginClassName: 'error-glyph',
            }
          }]);
          
          // Clear the decoration after 3 seconds
          setTimeout(() => {
            editor.deltaDecorations(decoration, []);
          }, 3000);
        }
      }
    }
  };

  const primaryError = errorChain?.[0];
  const hasNestedErrors = errorChain && errorChain.length > 1;

  return (
    <div className={`bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 ${className}`}>
      {/* Primary error */}
      <div className="flex items-start gap-2">
        <AlertTriangle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-red-700 dark:text-red-300">Error</span>
            {primaryError?.line && primaryError?.column && (
              <button
                onClick={() => primaryError && navigateToError(primaryError)}
                className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-200 hover:underline"
                title={`Navigate to line ${primaryError.line}, column ${primaryError.column}`}
              >
                <ExternalLink size={12} />
                Line {primaryError.line}, Col {primaryError.column}
              </button>
            )}
            {hasNestedErrors && (
              <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-200"
              >
                {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                {errorChain.length - 1} nested error{errorChain.length > 2 ? 's' : ''}
              </button>
            )}
          </div>
          <p className="text-sm text-red-700 dark:text-red-300 mt-1 font-mono break-words">
            {primaryError?.message || error}
          </p>
        </div>
      </div>

      {/* Nested errors */}
      {isExpanded && hasNestedErrors && (
        <div className="mt-4 pl-6 border-l-2 border-red-300 dark:border-red-700">
          {errorChain.slice(1).map((errorInfo, index) => (
            <div key={index} className="mb-3 last:mb-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-medium text-red-600 dark:text-red-400">
                  Caused by ({errorInfo.name}):
                </span>
                {errorInfo.line && errorInfo.column && (
                  <button
                    onClick={() => navigateToError(errorInfo)}
                    className="flex items-center gap-1 text-xs text-red-500 dark:text-red-500 hover:text-red-700 dark:hover:text-red-300 hover:underline"
                    title={`Navigate to line ${errorInfo.line}, column ${errorInfo.column}`}
                  >
                    <ExternalLink size={10} />
                    Line {errorInfo.line}, Col {errorInfo.column}
                  </button>
                )}
              </div>
              <p className="text-xs text-red-600 dark:text-red-400 font-mono break-words">
                {errorInfo.message}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};