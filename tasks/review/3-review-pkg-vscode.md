---
description: Comprehensive review of VS Code extension package
dependencies: 3-review-core-api
priority: 3
---

# VS Code Extension Review Plan

Review plan for `quereus-vscode`: SQL language support, query execution, schema visualization, debugging, and LSP features.

**Package location:** `packages/quereus-vscode/`

## Review Checklist

### API Surface Review
- [ ] Document extension public API
- [ ] Review LSP protocol implementation
- [ ] Verify command API contracts
- [ ] Check VS Code API usage
- [ ] Review Quereus core integration points
- [ ] Assess API stability needs
- [ ] Document extension points

### Configuration & Environment Handling
- [ ] Document VS Code settings schema
- [ ] Review configuration options
- [ ] Verify environment variable usage
- [ ] Check workspace vs user settings
- [ ] Review activation events configuration
- [ ] Assess configuration validation

### Security Considerations
- [ ] Review language server process security
- [ ] Verify input validation on commands
- [ ] Check file system access controls
- [ ] Review webview content security
- [ ] Verify secure communication (LSP)
- [ ] Check dependency vulnerabilities
- [ ] Assess extension permissions

### Error Handling
- [ ] Standardize extension error types
- [ ] Verify language server crash handling
- [ ] Check parse error handling
- [ ] Review connection error recovery
- [ ] Verify graceful degradation
- [ ] Assess user-facing error messages

### Logging & Telemetry
- [ ] Add extension activation logging
- [ ] Track command usage
- [ ] Log language server events
- [ ] Review VS Code output channel usage
- [ ] Check telemetry privacy compliance
- [ ] Assess performance logging

### Packaging, Build & Release
- [ ] Review package.json (contribution points)
- [ ] Verify build configuration
- [ ] Check extension packaging
- [ ] Review VS Code marketplace metadata
- [ ] Verify extension size limits
- [ ] Assess activation performance
- [ ] Review update mechanism

### Versioning Boundaries & Cross-Package Contracts
- [ ] Review Quereus core dependency version
- [ ] Check VS Code API version compatibility
- [ ] Verify LSP protocol version
- [ ] Review breaking change handling
- [ ] Assess extension versioning strategy

### Test Plan Expectations
- [ ] Unit tests: extension activation
- [ ] Unit tests: command handlers
- [ ] Unit tests: language server features
- [ ] Integration tests: LSP protocol
- [ ] Integration tests: VS Code API usage
- [ ] E2E tests: user workflows
- [ ] Performance tests: startup time, memory

## Files to Review

### Extension Entry
- `extension.ts` (activation, deactivation, commands, language client)

### Language Server
- Document parsing
- Completion provider
- Diagnostics
- Hover information
- Go to definition
- Formatting

### Client
- Server process spawn
- Communication setup
- Error handling

### Commands
- Execute query
- Format SQL
- Show schema
- Other features

### Views
- Schema tree view
- Results view
- Custom panels

## Code Quality Concerns

### VS Code Best Practices
- Extension size optimization
- Activation events efficiency
- Contribution points organization
- Settings schema completeness

### Performance Issues
- Server startup time
- Parsing performance
- Memory usage
- Resource cleanup

### LSP Compliance
- Correct protocol implementation
- All capabilities declared
- Proper error responses
- Protocol version compatibility

## LSP Feature Review

- Text document sync (open/close/change/save)
- Completion (keywords, tables/columns, functions, snippets)
- Diagnostics (syntax, semantic errors, warnings)
- Hover (table/column info, function signatures)
- Formatting, rename, references, definition

## Documentation Gaps

- User guide (installation, features, configuration, troubleshooting)
- Feature reference (commands, settings, keyboard shortcuts)
- Development guide (setup, debugging, testing, publishing)
- Marketplace description and screenshots
