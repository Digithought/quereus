---
description: Performance, error handling, and testability issues in quereus-vscode language server
dependencies: []

---

# VS Code Server Quality Issues

## Performance: O(n) span lookup in semantic tokens

`isInsideComment` and `isInsideSpans` in `server/src/server.ts` lines 182–199 do linear scans over all spans for every regex match. For large files with many comments/strings, this is O(n²). Sort spans and use binary search, or build an interval lookup.

## Performance: repeated getText().split('\n')

`pushMultiline` in `server/src/server.ts` lines 268–287 calls `doc.getText().split('\n')` on every line of a multi-line token. Cache the split result or use `TextDocument.positionAt()`.

## Re-implemented positionAt

`positionAt` at line 256 reimplements `TextDocument.positionAt()` which is already available from `vscode-languageserver-textdocument`. Replace with `doc.positionAt(offset)`.

## Overly broad file watcher

`client/src/extension.ts` line 20: `workspace.createFileSystemWatcher('**/*')` watches every file. Scope to SQL files: `**/*.{sql,qsql}`.

## Swallowed errors in activate

`client/src/extension.ts` lines 29–33: `void (async () => { ... })()` swallows startup errors silently. At minimum log to the output channel, or use `.catch()`.

## Context-free completions

`onCompletion` in `server/src/server.ts` line 119 ignores cursor position — returns all keywords/tables regardless of SQL context. Future improvement: use cursor position and partial parse to provide relevant completions.

## Stub hover

`onHover` at line 144 always returns `null`. Either remove the capability declaration or implement basic hover (table/column info from schema).

## Module-level side effects

`connection` and `documents` are created at module scope (lines 21–22). This prevents unit testing individual handlers in isolation. Refactor to a factory/init pattern.

## Inconsistent indentation

`onInitialize` handler at line 56 has an extra tab of indentation compared to the rest of the file.

