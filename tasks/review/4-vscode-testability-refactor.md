---
description: Refactored quereus-vscode server for testability — extracted pure handler functions
dependencies: []
files:
  - packages/quereus-vscode/server/src/handlers.ts
  - packages/quereus-vscode/server/src/server.ts
  - packages/quereus-vscode/server/test/handlers.spec.ts
---

# VS Code Server Testability Refactor

## What changed

Extracted all handler logic from `server.ts` into pure functions in a new `handlers.ts` module. `server.ts` is now a thin wiring layer that connects LSP events to the pure functions.

### New file: `server/src/handlers.ts`

Pure, side-effect-free functions:

- **`getCompletions(db, externalSchema, keywords)`** — builds completion items from keywords, DB schema, and external schema snapshot
- **`computeDiagnostics(text, Parser)`** — parses SQL text and returns diagnostics array (no connection.sendDiagnostics side effect)
- **`tokenize(text, keywords)`** — regex-based tokenization returning `RawToken[]` (classified spans with no LSP dependency)
- **`buildSemanticTokens(tokens, doc, lines)`** — converts raw tokens into LSP `SemanticTokens`
- **Helper exports:** `toRange`, `sortAndMergeSpans`, `isInsideSortedSpans`
- **Constant exports:** `SQL_KEYWORDS`, `tokenTypes`, `tokenTypeToIndex`

### Modified file: `server/src/server.ts`

Slim wiring layer — creates connection/documents, imports from handlers, wires LSP events. ~75 lines down from ~277.

## Testing

26 new tests in `server/test/handlers.spec.ts` covering:

- `getCompletions` — null db, real db with tables/columns, external schema with tables/functions
- `computeDiagnostics` — valid SQL, invalid SQL, incomplete SQL
- `tokenize` — keywords, functions, strings, numbers, comments (line + block), operators, exclusion zones (keywords inside strings/comments), sort/overlap invariant
- `buildSemanticTokens` — single-line and multiline SQL
- `sortAndMergeSpans` — empty, overlapping, non-overlapping, adjacent
- `isInsideSortedSpans` — inside, outside, boundary conditions
- `toRange` — 1-indexed to 0-indexed conversion

All 31 tests pass (26 new + 5 existing schema-bridge tests).

## Validation

- `yarn workspace quereus-vscode test` — 31 passing
- esbuild server bundle succeeds
