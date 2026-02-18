---
description: DRY violations and type safety issues in quereus-vscode
dependencies: []

---

# VS Code Extension DRY & Type Safety

## SchemaSnapshot defined 3 times

`SchemaSnapshot` and `SchemaSnapshotTable` are identically defined in three places:

- `client/src/schema-sync.ts` lines 3–12
- `server/src/commands.ts` lines 5–14
- `server/src/schema-bridge.ts` lines 3–12

Extract to a shared location. Since client and server are separate bundles (esbuild), a shared source file under a common directory (e.g. `shared/types.ts`) imported by both would work — esbuild will inline it.

## Double cast on connection

`server/src/server.ts` line 59:
```ts
registerCommands(connection as unknown as any, db, applySchemaSnapshot);
```

`connection` is `Connection` from `vscode-languageserver/node`, `registerCommands` expects `Connection` from `vscode-languageserver`. These are the same underlying type. The double cast masks a potential real type mismatch. Align the import so no cast is needed.

## Hardcoded keywords

`server/src/server.ts` lines 40–50 hardcodes `DEFAULT_KEYWORDS` instead of importing `KEYWORDS` from `@quereus/quereus`. The engine already exports the canonical keyword list. Use it and remove the duplicate.

