import React, { useEffect, useMemo, useState } from 'react';
import { MainLayout } from './components/MainLayout.js';
import { useSessionStore } from './stores/sessionStore.js';
import { useSettingsStore } from './stores/settingsStore.js';

export const App: React.FC = () => {
  const { initializeSession } = useSessionStore();
  const { loadSettings, theme } = useSettingsStore();
  const [systemIsDark, setSystemIsDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  );

  // Resolve the actual theme to apply
  const resolvedTheme = useMemo(() => {
    if (theme === 'auto') {
      return systemIsDark ? 'dark' : 'light';
    }
    return theme;
  }, [theme, systemIsDark]);

  useEffect(() => {
    // Initialize settings and session on app start
    loadSettings();
    initializeSession();
  }, [loadSettings, initializeSession]);

  useEffect(() => {
    // Listen for system theme changes
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e: MediaQueryListEvent) => {
      setSystemIsDark(e.matches);
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  return (
    <div className={`app ${resolvedTheme}`} data-theme={resolvedTheme}>
      <MainLayout />
    </div>
  );
};
