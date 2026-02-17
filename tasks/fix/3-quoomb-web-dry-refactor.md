---
description: DRY refactoring and code quality improvements in quoomb-web
dependencies: 3-review-pkg-quoomb-web
priority: 3
---

# Quoomb Web DRY Refactoring

Code quality improvements found during review of `packages/quoomb-web/`.

## 1. Consolidate File Save Functions

**File:** `src/stores/sessionStore.ts` lines 716–794

`saveCurrentTabAsFile` and `saveTabAsFile` are nearly identical. The only difference is tab lookup: one uses `activeTabId`, the other takes a `tabId` parameter.

**Fix:** Consolidate into a single `saveTabAsFile(tabId?: string)` that defaults to `activeTabId` when no argument is provided. Remove `saveCurrentTabAsFile` and update all callers.

## 2. Extract CSV Formatting Utility

**Files:** `src/stores/sessionStore.ts` line 644 (`exportResultsAsCSV`) and `src/components/ResultsGrid.tsx` line 76 (`copyAsCSV`)

Both contain identical CSV header/row generation with comma escaping and quote doubling logic.

**Fix:** Extract a shared `formatRowsAsCSV(rows: Record<string, unknown>[])` utility into `src/utils/csv.ts`. Both consumers call it with their respective row data.

## 3. Extract Download-as-File Utility

**File:** `src/stores/sessionStore.ts` — three locations

The Blob → `URL.createObjectURL` → create `<a>` link → click → cleanup pattern is repeated in `exportResultsAsCSV`, `exportResultsAsJSON`, and `saveCurrentTabAsFile`/`saveTabAsFile`.

**Fix:** Extract `downloadBlob(content: string, filename: string, mimeType: string)` utility into `src/utils/download.ts`.

## 4. EnhancedErrorDisplay Fragile Monaco Coupling

**File:** `src/components/EnhancedErrorDisplay.tsx` lines 48–60

Uses `(window as any).monaco` and DOM querying (`document.querySelector('[data-uri*="model"]')`) to navigate to error locations. This is brittle and not type-safe.

**Fix:** Expose a proper `navigateToError(line, column)` callback from EditorPanel or a shared context/ref, instead of reaching into Monaco internals through the global window object.

## 5. sessionStore Decomposition (1267 lines)

**File:** `src/stores/sessionStore.ts`

At 1267 lines this store handles tabs, query execution, history, results, plugins, sync, file I/O, and export. Candidates for extraction into separate modules:
- Tab management (create, close, activate, save/load)
- Query execution and results
- Export utilities (CSV, JSON, file save)
- Sync state management

**Fix:** Extract logical groups into separate files (e.g., `src/stores/session/tabs.ts`, `src/stores/session/export.ts`) and compose them in the main store using Zustand slices pattern or simple function imports.

## TODO

- [ ] Create `src/utils/csv.ts` with shared CSV formatting function
- [ ] Create `src/utils/download.ts` with shared download-as-file function
- [ ] Consolidate `saveCurrentTabAsFile`/`saveTabAsFile` into single function
- [ ] Replace `(window as any).monaco` in EnhancedErrorDisplay with proper API
- [ ] Decompose sessionStore into logical modules
- [ ] Update all callers and existing tests after refactoring

