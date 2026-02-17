---
description: Review plan for tooling packages under packages/tools
dependencies: 3-review-core-api
priority: 4
---

# Tools Package Review Plan

This document provides a review plan for the tooling packages under `packages/tools/` (CLI/dev tools shipped alongside Quereus).

## 1. Scope

The tools package provides:

- Tool-specific CLIs (e.g. visualization/debugging helpers)
- Developer workflows and examples
- Packaging/distribution ergonomics

**Package location:** `packages/tools/` (currently contains `planviz/`).

## 2. Architecture Assessment

### Expected Components

1. **CLI Entry** - Command-line argument parsing
2. **Commands** - Individual command implementations
3. **Formatters** - Output formatting / rendering
5. **Utilities** - Shared helpers

### CLI ergonomics to verify

- Input/output handling (stdin/stdout, pipes)
- Error formatting (actionable, consistent exit codes)
- Cross-platform behavior (Windows/macOS/Linux)

## 3. Files to Review

### CLI Entry

**Main entry:**
- Argument parsing
- Command dispatch
- Global options
- Error handling

### Commands

**Individual commands:**
- Inventory commands that exist in `packages/tools/**/src/cli.ts` / `src/bin/*`
- Verify each command has clear UX, help text, and predictable exit codes

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
// packages/tools/planviz/test/cli.spec.ts
describe('planviz CLI', () => {
  it('parses arguments correctly')
  it('prints help')
  it('handles missing/invalid arguments')
  it('sets exit codes correctly')
})

// packages/tools/planviz/test/visualizer.spec.ts
describe('plan visualizer', () => {
  it('renders a minimal plan')
  it('handles invalid input')
})
```

## 6. Documentation Gaps

### Missing Documentation

1. **Command Reference**
   - All commands documented
   - All options documented
   - Examples for each

2. **Installation Guide**
   - How to run each tool (dev + built)
   - How to publish/distribute (if intended)

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
