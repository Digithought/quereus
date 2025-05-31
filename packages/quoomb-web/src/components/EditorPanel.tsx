import React, { useCallback, useRef } from 'react';
import { Editor } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { useSessionStore } from '../stores/sessionStore.js';
import { useSettingsStore } from '../stores/settingsStore.js';
import { TabBar } from './TabBar.js';
import { Play, Square } from 'lucide-react';

export const EditorPanel: React.FC = () => {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

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

  const activeTab = tabs.find(tab => tab.id === activeTabId);

  const handleEditorDidMount = useCallback((editor: editor.IStandaloneCodeEditor) => {
    editorRef.current = editor;

    // Add keyboard shortcuts using the editor's addCommand method
    if (autoExecuteOnShiftEnter) {
      editor.addCommand(editor.getModel()?.getLanguageId() === 'sql' ? 2048 + 3 : 0, () => {
        handleExecute();
      });
    }
  }, [autoExecuteOnShiftEnter]);

  const handleEditorChange = useCallback((value: string | undefined) => {
    if (activeTabId && value !== undefined) {
      updateTabContent(activeTabId, value);
    }
  }, [activeTabId, updateTabContent]);

  const handleExecute = useCallback(async () => {
    if (!activeTab?.content.trim() || isExecuting) return;

    try {
      // Get selected text or full content
      const editor = editorRef.current;
      let sqlToExecute = activeTab.content;

      if (editor) {
        const selection = editor.getSelection();
        if (selection && !selection.isEmpty()) {
          const selectedText = editor.getModel()?.getValueInRange(selection);
          if (selectedText?.trim()) {
            sqlToExecute = selectedText;
          }
        }
      }

      await executeSQL(sqlToExecute);
    } catch (error) {
      console.error('Execution error:', error);
    }
  }, [activeTab, executeSQL, isExecuting]);

  const handleStop = useCallback(() => {
    // TODO: Implement query cancellation
    console.log('Stop execution requested');
  }, []);

  return (
    <div className="h-full flex flex-col">
      {/* Tab bar */}
      <TabBar />

      {/* Editor container */}
      <div className="flex-1 relative">
        {activeTab ? (
          <>
            {/* Editor */}
            <Editor
              height="100%"
              language="sql"
              value={activeTab.content}
              onChange={handleEditorChange}
              onMount={handleEditorDidMount}
              theme={theme === 'dark' ? 'vs-dark' : 'vs'}
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
            <div className="absolute bottom-4 right-4 flex gap-2">
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
