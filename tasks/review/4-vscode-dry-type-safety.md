---
description: DRY violations and type safety fixes in quereus-vscode
dependencies: []
files:
  - packages/quereus-vscode/shared/types.ts
  - packages/quereus-vscode/client/src/schema-sync.ts
  - packages/quereus-vscode/server/src/commands.ts
  - packages/quereus-vscode/server/src/schema-bridge.ts
  - packages/quereus-vscode/server/src/server.ts
  - packages/quereus-vscode/server/tsconfig.json
  - packages/quereus-vscode/client/tsconfig.json
  - packages/quereus-vscode/tsconfig.test.json
---

# VS Code Extension DRY & Type Safety — Review

## Changes Made

### 1. SchemaSnapshot types extracted to shared location

`SchemaSnapshot` and `SchemaSnapshotTable` were defined identically in three files. Extracted to `shared/types.ts` and all three consumers now import from there. The tsconfigs for server, client, and tests were updated to include `shared/` in their compilation scope (`rootDir` widened to `..`).

### 2. Double cast removed

`server.ts` line 58 had `connection as unknown as any`. The root cause was `commands.ts` importing `Connection` from `'vscode-languageserver'` while `server.ts` uses `createConnection` from `'vscode-languageserver/node'`. Fixed by aligning the import in `commands.ts` to `'vscode-languageserver/node'`. The cast is now gone — `registerCommands(connection, db, applySchemaSnapshot)`.

### 3. Hardcoded keywords replaced with engine export

The 40+ hardcoded `DEFAULT_KEYWORDS` array was replaced with `Object.keys(KEYWORDS)` where `KEYWORDS` is statically imported from `@quereus/quereus`. Since esbuild bundles the engine into the server, the static import works directly. This ensures the keyword list stays in sync with the engine's lexer automatically.

## Testing & Validation

- All 5 existing `snapshotSchema` tests pass
- TypeScript typecheck passes for both server and client (`tsc --noEmit`)
- esbuild bundles both server (2.1MB) and client (767KB) successfully
- No runtime casts or type assertions remain for these areas
