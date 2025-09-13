Quereus SQL VS Code Extension

Provides language support for Quereus SQL in VS Code:

- Syntax highlighting (TextMate + semantic tokens)
- Diagnostics (syntax errors via Quereus parser)
- Completions for keywords, functions, tables, and columns
- Hover (placeholder)

Development

- Build: yarn workspace @quereus/quereus-vscode build
- Launch: Open this folder in VS Code, run the "Run Extension" launch config.

Schema awareness

The server hoists an in-memory `Database` instance to read currently-known tables/functions. Future enhancements can connect to a running app and sync schema.


