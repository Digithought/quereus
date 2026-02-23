---
description: Refactor quereus-vscode language server for testability — factory/init pattern
dependencies: []
---

# VS Code Server Testability Refactor

## Module-level side effects

`connection` and `documents` are created at module scope (`server/src/server.ts` lines 20–21). All handlers are registered as side effects of importing the module. This prevents unit testing individual handlers (completion, semantic tokens, validation) in isolation.

## Goal

Refactor to a factory/init pattern so that:
- Handlers can be tested without a live LSP connection
- The semantic tokens logic, completion logic, and validation logic can be exercised in isolation with mock `TextDocument` objects
- Module import doesn't trigger side effects

## Approach

Extract handler logic into pure functions that accept explicit dependencies (document text, schema state, etc.) and return results. The module entry point wires these into the LSP connection.

## Context-free completions (related, lower priority)

`onCompletion` ignores cursor position — returns all keywords/tables regardless of SQL context. Future improvement: use cursor position and partial parse to provide contextually relevant completions. This is more of a feature enhancement than a quality fix.
