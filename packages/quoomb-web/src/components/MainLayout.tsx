import React from 'react';
import Split from 'react-split';
import { EditorPanel } from './EditorPanel.js';
import { ResultsPanel } from './ResultsPanel.js';
import { Toolbar } from './Toolbar.js';
import { StatusBar } from './StatusBar.js';
import { useSessionStore } from '../stores/sessionStore.js';
import { ConnectionError } from './ConnectionError.js';

export const MainLayout: React.FC = () => {
  const { isConnected, isConnecting, connectionError } = useSessionStore();

  // Show connection error if not connected
  if (!isConnected && !isConnecting && connectionError) {
    return <ConnectionError error={connectionError} />;
  }

  // Show loading if connecting
  if (isConnecting) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mb-4"></div>
          <p className="text-gray-600">Connecting to Quereus...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col">
      {/* Top toolbar */}
      <Toolbar />

      {/* Main content area with split panes */}
      <div className="flex-1 overflow-hidden">
        <Split
          direction="horizontal"
          sizes={[50, 50]}
          minSize={200}
          expandToMin={false}
          gutterSize={6}
          gutterAlign="center"
          snapOffset={30}
          dragInterval={1}
          gutterStyle={() => ({
            backgroundColor: 'var(--border-color)',
            cursor: 'row-resize',
          })}
          style={{ height: '100%' }}
        >
          {/* Top pane - Editor */}
          <div className="flex flex-col overflow-hidden">
            <EditorPanel />
          </div>

          {/* Bottom pane - Results */}
          <div className="flex flex-col overflow-hidden">
            <ResultsPanel />
          </div>
        </Split>
      </div>

      {/* Bottom status bar */}
      <StatusBar />
    </div>
  );
};
