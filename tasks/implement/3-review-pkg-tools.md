---
description: Comprehensive review of quereus-tools package (CLI)
dependencies: 3-review-core-api
priority: 4
---

# Tools Package Review Plan

This document provides a comprehensive adversarial review plan for the `quereus-tools` package (CLI tools).

## 1. Scope

The tools package provides:

- Command-line interface for Quereus
- SQL REPL
- Schema management commands
- Import/export utilities
- Development tools

**Package location:** `packages/quereus-tools/`

## 2. Architecture Assessment

### Expected Components

1. **CLI Entry** - Command-line argument parsing
2. **REPL** - Interactive SQL shell
3. **Commands** - Individual command implementations
4. **Formatters** - Output formatting
5. **Utilities** - Shared helpers

### CLI Framework

- Commander.js (per README)
- Input/output handling
- Error formatting

## 3. Files to Review

### CLI Entry

**Main entry:**
- Argument parsing
- Command dispatch
- Global options
- Error handling

### Commands

**Individual commands:**
- `exec` - Execute SQL
- `schema` - Schema operations
- `import` - Data import
- `export` - Data export
- Others

### REPL

**Interactive shell:**
- Input handling
- History
- Completion
- Multi-line input

### Formatters

**Output formatting:**
- Table format
- JSON format
- CSV format
- Other formats

## 4. Code Quality Concerns

### Potential Issues

1. **Error Messages**
   - User-friendly?
   - Actionable?
   - Exit codes correct?

2. **Input Validation**
   - File paths validated?
   - SQL validated before exec?
   - Options validated?

3. **Resource Management**
   - File handles closed?
   - Database connections closed?
   - Temp files cleaned?

4. **Cross-Platform**
   - Works on Windows?
   - Works on macOS?
   - Works on Linux?

### CLI Best Practices

- Help text quality
- Consistent option naming
- Progress indicators
- Quiet/verbose modes

## 5. Test Coverage Gaps

### Missing Tests

```typescript
// test/tools/cli.spec.ts
describe('CLI', () => {
  it('parses arguments correctly')
  it('shows help for all commands')
  it('handles missing arguments')
  it('handles invalid arguments')
  it('sets exit codes correctly')
})

// test/tools/commands.spec.ts
describe('Commands', () => {
  describe('exec', () => {
    it('executes SQL from argument')
    it('executes SQL from file')
    it('executes SQL from stdin')
    it('handles errors')
  })
  
  describe('schema', () => {
    it('lists tables')
    it('describes table')
    it('handles missing table')
  })
  
  describe('import', () => {
    it('imports CSV')
    it('imports JSON')
    it('handles invalid data')
  })
  
  describe('export', () => {
    it('exports to CSV')
    it('exports to JSON')
    it('handles large tables')
  })
})

// test/tools/repl.spec.ts
describe('REPL', () => {
  it('executes single-line queries')
  it('executes multi-line queries')
  it('shows results')
  it('handles errors')
  it('supports history')
})
```

## 6. Documentation Gaps

### Missing Documentation

1. **Command Reference**
   - All commands documented
   - All options documented
   - Examples for each

2. **Installation Guide**
   - npm global install
   - npx usage
   - PATH setup

3. **Usage Guide**
   - Common workflows
   - Examples
   - Tips

## 7. TODO

### Phase 1: Assessment
- [ ] Inventory all commands
- [ ] Document command structure
- [ ] Review argument parsing
- [ ] Review output formatting

### Phase 2: Code Quality
- [ ] Review error messages
- [ ] Check input validation
- [ ] Verify resource cleanup
- [ ] Test cross-platform

### Phase 3: Testing
- [ ] Add CLI tests
- [ ] Add command tests
- [ ] Add REPL tests
- [ ] Add cross-platform tests

### Phase 4: Documentation
- [ ] Create command reference
- [ ] Create installation guide
- [ ] Create usage guide
- [ ] Add man page (if applicable)
