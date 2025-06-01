import React, { useCallback, useRef, useMemo, useState, useEffect } from 'react';
import { Editor } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { useSessionStore } from '../stores/sessionStore.js';
import { useSettingsStore } from '../stores/settingsStore.js';
import { TabBar } from './TabBar.js';
import { Play, Square } from 'lucide-react';

export const EditorPanel: React.FC = () => {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [systemIsDark, setSystemIsDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  );

  const {
    tabs,
    activeTabId,
    updateTabContent,
    executeSQL,
    isExecuting,
  } = useSessionStore();

  const {
    theme,
    fontSize,
    fontFamily,
    wordWrap,
    showLineNumbers,
    showMinimap,
    autoExecuteOnShiftEnter,
  } = useSettingsStore();

  // Resolve the actual theme to apply (same logic as App.tsx)
  const resolvedTheme = useMemo(() => {
    if (theme === 'auto') {
      return systemIsDark ? 'dark' : 'light';
    }
    return theme;
  }, [theme, systemIsDark]);

  // Listen for system theme changes
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e: MediaQueryListEvent) => {
      setSystemIsDark(e.matches);
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  // Add ResizeObserver to handle split pane resizing
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const resizeObserver = new ResizeObserver(() => {
      // Trigger Monaco layout recalculation when container size changes
      if (editorRef.current) {
        // Small delay to ensure the container has finished resizing
        setTimeout(() => {
          editorRef.current?.layout();
        }, 10);
      }
    });

    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  const activeTab = tabs.find(tab => tab.id === activeTabId);

  const handleExecute = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor || isExecuting) return;

    try {
      // Get selected text or full content from current editor state
      const selection = editor.getSelection();
      let sqlToExecute: string;

      if (selection && !selection.isEmpty()) {
        const selectedText = editor.getModel()?.getValueInRange(selection);
        sqlToExecute = selectedText?.trim() || '';
      } else {
        // Get current full content from editor
        sqlToExecute = editor.getValue().trim();
      }

      if (!sqlToExecute) return;

      await executeSQL(sqlToExecute);
    } catch (error) {
      console.error('Execution error:', error);
    }
  }, [executeSQL, isExecuting]);

  const handleEditorDidMount = useCallback((editor: editor.IStandaloneCodeEditor) => {
    editorRef.current = editor;

    // Add keyboard shortcut for Shift+Enter
    if (autoExecuteOnShiftEnter) {
      editor.addAction({
        id: 'execute-sql',
        label: 'Execute SQL',
        keybindings: [
          // Shift+Enter
          2048 | 3, // Monaco.KeyMod.Shift | Monaco.KeyCode.Enter
        ],
        run: () => {
          handleExecute();
        },
      });
    }

    // Initial layout to ensure proper sizing
    setTimeout(() => {
      editor.layout();
    }, 100);
  }, [autoExecuteOnShiftEnter, handleExecute]);

  const handleEditorChange = useCallback((value: string | undefined) => {
    if (activeTabId && value !== undefined) {
      updateTabContent(activeTabId, value);
    }
  }, [activeTabId, updateTabContent]);

  const handleStop = useCallback(() => {
    // TODO: Implement query cancellation
    console.log('Stop execution requested');
  }, []);

  return (
    <div className="h-full flex flex-col">
      {/* Tab bar */}
      <TabBar />

      {/* Editor container */}
      <div ref={containerRef} className="flex-1 relative overflow-hidden h-0">
        {activeTab ? (
          <>
            {/* Editor */}
            <Editor
              height="100%"
              language="sql"
              value={activeTab.content}
              onChange={handleEditorChange}
              onMount={handleEditorDidMount}
              theme={resolvedTheme === 'dark' ? 'vs-dark' : 'vs'}
              options={{
                fontSize,
                fontFamily,
                wordWrap: wordWrap ? 'on' : 'off',
                lineNumbers: showLineNumbers ? 'on' : 'off',
                minimap: { enabled: showMinimap },
                automaticLayout: true,
                scrollBeyondLastLine: false,
                renderWhitespace: 'selection',
                selectOnLineNumbers: true,
                roundedSelection: false,
                readOnly: false,
                cursorStyle: 'line',
                mouseWheelZoom: true,
                contextmenu: true,
                quickSuggestions: {
                  other: true,
                  comments: false,
                  strings: false
                },
                parameterHints: {
                  enabled: true
                },
                suggestOnTriggerCharacters: true,
                acceptSuggestionOnEnter: 'on',
                tabCompletion: 'on',
                wordBasedSuggestions: 'off',
                // SQL specific options
                bracketPairColorization: {
                  enabled: true
                },
                guides: {
                  bracketPairs: true
                }
              }}
            />

            {/* Floating execute button */}
            <div className="absolute bottom-4 right-4 flex gap-2 z-10">
              {isExecuting ? (
                <button
                  onClick={handleStop}
                  className="flex items-center gap-2 px-4 py-2 bg-red-500 hover:bg-red-600 text-white rounded-lg shadow-lg transition-colors"
                  title="Stop execution"
                >
                  <Square size={16} />
                  Stop
                </button>
              ) : (
                <button
                  onClick={handleExecute}
                  disabled={!activeTab.content.trim()}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-400 text-white rounded-lg shadow-lg transition-colors"
                  title="Execute SQL (Shift+Enter)"
                >
                  <Play size={16} />
                  Execute
                </button>
              )}
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-gray-500">
            <p>No editor tab open</p>
          </div>
        )}
      </div>
    </div>
  );
};
