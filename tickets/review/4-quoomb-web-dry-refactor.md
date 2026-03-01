---
description: DRY refactoring and code quality improvements in quoomb-web
dependencies: 3-review-pkg-quoomb-web
---

# Quoomb Web DRY Refactoring — Review

## Summary

Five code quality improvements applied to `packages/quoomb-web/`:

### 1. CSV Formatting Utility
Extracted duplicate CSV generation logic into `src/utils/csv.ts` (`formatRowsAsCSV`). Used by both `sessionStore.exportResultsAsCSV` and `ResultsGrid.copyAsCSV`.

### 2. Download-as-File Utility
Extracted the repeated Blob→ObjectURL→anchor→click→cleanup pattern into `src/utils/download.ts` (`downloadBlob`). Used by CSV export, JSON export, and tab save.

### 3. Consolidated File Save Functions
Merged `saveCurrentTabAsFile()` and `saveTabAsFile(tabId)` into a single `saveTabAsFile(tabId?: string)` that defaults to active tab. Updated callers in App.tsx, FileMenu.tsx; MainLayout.tsx already used the parameterized form.

### 4. EnhancedErrorDisplay Monaco Decoupling
Removed brittle `(window as any).monaco` and `document.querySelector('[data-uri*="model"]')` access. Instead, EditorPanel registers a `navigateToError(line, column)` callback in the session store via `setNavigateToError`. EnhancedErrorDisplay calls this callback. Monaco access now goes through `@monaco-editor/react`'s `loader.init()`.

### 5. sessionStore Decomposition (1267 → 423 lines)
Extracted action groups into `src/stores/session/`:
- `types.ts` — shared `SessionState`, `Tab`, `QueryResult`, `StoreSet`/`StoreGet` types
- `tabs.ts` — tab CRUD, unsaved changes dialog, shared `removeTab` helper (DRY'd closeTab/forceCloseTab)
- `export.ts` — CSV/JSON export, save tab as file, load SQL file
- `plugins.ts` — install, toggle, config, reload, error tracking, startup loading
- `sync.ts` — sync status, events, connect/disconnect with validation

Main store composes via `...createTabActions(set, get)` spread pattern.

## Key Files
- `packages/quoomb-web/src/utils/csv.ts` — CSV formatting
- `packages/quoomb-web/src/utils/download.ts` — browser download trigger
- `packages/quoomb-web/src/stores/sessionStore.ts` — composition root (423 lines)
- `packages/quoomb-web/src/stores/session/types.ts` — shared types
- `packages/quoomb-web/src/stores/session/tabs.ts` — tab management
- `packages/quoomb-web/src/stores/session/export.ts` — export/file I/O
- `packages/quoomb-web/src/stores/session/plugins.ts` — plugin management
- `packages/quoomb-web/src/stores/session/sync.ts` — sync management
- `packages/quoomb-web/src/components/EnhancedErrorDisplay.tsx` — decoupled from Monaco
- `packages/quoomb-web/src/components/EditorPanel.tsx` — registers navigateToError
- `packages/quoomb-web/src/components/ResultsGrid.tsx` — uses shared CSV util
- `packages/quoomb-web/src/components/FileMenu.tsx` — uses consolidated saveTabAsFile
- `packages/quoomb-web/src/App.tsx` — uses consolidated saveTabAsFile

## Testing
- All 59 quoomb-web tests pass (3 test files)
- Full project build succeeds
- Test areas: CSV copy, file save (Ctrl+S), file menu save, error navigation from results panel, export CSV/JSON, tab lifecycle, plugin management, sync events
