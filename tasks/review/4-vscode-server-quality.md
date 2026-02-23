---
description: Performance, error handling, and quality fixes for quereus-vscode language server
dependencies: []
---

# VS Code Server Quality — Review

## Changes Made

### Performance: O(n) span lookup → O(log n) binary search
- `server/src/server.ts`: Extracted `sortAndMergeSpans()` and `isInsideSortedSpans()` utilities
- Comment and string spans are now sorted and merged after collection
- All `isInsideComment` / `isInsideSpans` checks use binary search on sorted spans
- Reduces semantic token computation from O(n²) to O(n log n) for files with many comments/strings

### Performance: eliminated repeated getText().split('\n')
- `pushMultiline()` now accepts a pre-split `lines` array parameter
- Lines are split once at the top of the semantic tokens handler and passed through
- Previously split the entire document text on every line of a multi-line token

### Replaced custom positionAt with TextDocument.positionAt()
- Removed the hand-rolled `positionAt()` function (lines 256–264)
- `pushRange()` and `pushMultiline()` now use `doc.positionAt()` from `vscode-languageserver-textdocument`

### Scoped file watcher
- `client/src/extension.ts`: Changed `workspace.createFileSystemWatcher('**/*')` to `'**/*.{sql,qsql}'`

### Error handling in activate
- `client/src/extension.ts`: Added `.catch()` to the async IIFE so startup errors are logged instead of silently swallowed

### Removed stub hover
- Removed `hoverProvider: true` from server capabilities
- Removed the `onHover` handler that always returned `null`
- Removed unused `Hover` import

### Fixed inconsistent indentation
- `onInitialize` handler was indented one extra tab compared to the rest of the file; corrected to match

## Deferred Items

- **Module-level side effects / testability**: Created `tasks/plan/3-vscode-testability-refactor.md`
- **Context-free completions**: Noted in the testability task as a future enhancement

## Validation

- `yarn typecheck` passes (both server and client)
- `yarn test` passes (5/5 schema-bridge tests)
- `esbuild` bundle succeeds

## Files Changed

- `packages/quereus-vscode/server/src/server.ts` — all server-side fixes
- `packages/quereus-vscode/client/src/extension.ts` — file watcher scope + error handling
