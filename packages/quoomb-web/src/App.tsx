import React, { useEffect } from 'react';
import { MainLayout } from './components/MainLayout.js';
import { useSessionStore } from './stores/sessionStore.js';
import { useSettingsStore } from './stores/settingsStore.js';

export const App: React.FC = () => {
  const { initializeSession } = useSessionStore();
  const { loadSettings, theme } = useSettingsStore();

  useEffect(() => {
    // Initialize settings and session on app start
    loadSettings();
    initializeSession();
  }, [loadSettings, initializeSession]);

  return (
    <div className={`app ${theme}`} data-theme={theme}>
      <MainLayout />
    </div>
  );
};
