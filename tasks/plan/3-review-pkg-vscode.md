---
description: Plan comprehensive review of quereus-vscode extension
dependencies: none
priority: 3
---

# quereus-vscode Extension Review Planning

Plan a thorough adversarial review of the VS Code extension.

## Scope

Package: `packages/quereus-vscode/`
- `client/src/extension.ts` - Extension activation
- `client/src/schema-sync.ts` - Schema synchronization
- `server/src/` - Language server (3 TypeScript files)
- `syntaxes/quereus.tmLanguage.json` - Syntax highlighting

## Review Objectives

The planned review tasks should:

1. **Architecture Review**
   - Client-server communication
   - Schema synchronization design
   - Language server protocol usage
   - Extension lifecycle

2. **Code Quality Review**
   - Error handling in extension
   - Resource cleanup on deactivation
   - Type safety
   - Configuration handling

3. **Test Coverage Assessment**
   - Extension activation tests
   - Language features tests
   - Syntax highlighting accuracy
   - Error scenario handling

4. **Defect Analysis**
   - Memory leaks during long sessions
   - Race conditions in schema sync
   - Error propagation to user
   - Performance with large files

## Output

This planning task produces detailed review tasks covering:
- Extension lifecycle verification
- Language server correctness
- Syntax highlighting completeness
- User experience quality
