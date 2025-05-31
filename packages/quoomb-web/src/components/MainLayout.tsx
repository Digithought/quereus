import React from 'react';
import Split from 'react-split';
import { EditorPanel } from './EditorPanel.js';
import { ResultsPanel } from './ResultsPanel.js';
import { Toolbar } from './Toolbar.js';
import { StatusBar } from './StatusBar.js';
import { UnsavedChangesDialog } from './UnsavedChangesDialog.js';
import { useSessionStore } from '../stores/sessionStore.js';
import { ConnectionError } from './ConnectionError.js';

export const MainLayout: React.FC = () => {
  const {
    isConnected,
    isConnecting,
    connectionError,
    unsavedChangesDialog,
    saveTabAsFile,
    forceCloseTab,
    hideUnsavedChangesDialog,
  } = useSessionStore();

  const handleSaveAndClose = async () => {
    if (!unsavedChangesDialog.tabId) return;

    try {
      await saveTabAsFile(unsavedChangesDialog.tabId);
      forceCloseTab(unsavedChangesDialog.tabId);
      hideUnsavedChangesDialog();
    } catch (error) {
      console.error('Failed to save and close tab:', error);
      // Dialog stays open if save fails
    }
  };

  const handleDiscardAndClose = () => {
    if (!unsavedChangesDialog.tabId) return;

    forceCloseTab(unsavedChangesDialog.tabId);
    hideUnsavedChangesDialog();
  };

  const handleCancelClose = () => {
    hideUnsavedChangesDialog();
  };

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
    <div className="h-screen w-full flex flex-col bg-gray-50 dark:bg-gray-900">
      {/* Top toolbar */}
      <Toolbar />

      {/* Main content area with split panes */}
      <div className="flex-1 w-full overflow-hidden">
        <Split
          direction="vertical"
          sizes={[60, 40]}
          minSize={[200, 150]}
          className="h-full w-full"
          style={{ height: '100%', width: '100%' }}
        >
          {/* Top pane - Editor */}
          <div className="h-full w-full bg-white dark:bg-gray-800 overflow-hidden">
            <EditorPanel />
          </div>

          {/* Bottom pane - Results */}
          <div className="h-full w-full bg-white dark:bg-gray-800 overflow-hidden">
            <ResultsPanel />
          </div>
        </Split>
      </div>

      {/* Bottom status bar */}
      <StatusBar />

      {/* Unsaved Changes Dialog */}
      <UnsavedChangesDialog
        isOpen={unsavedChangesDialog.isOpen}
        fileName={unsavedChangesDialog.fileName}
        onSave={handleSaveAndClose}
        onDiscard={handleDiscardAndClose}
        onCancel={handleCancelClose}
      />
    </div>
  );
};
