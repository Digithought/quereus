---
description: Comprehensive review of sample plugins
dependencies: 3-review-pkg-plugins
priority: 4
---

# Sample Plugins Review Plan

This document provides a comprehensive adversarial review plan for sample/example plugins.

## 1. Scope

Sample plugins serve as:

- Examples for plugin developers
- Test cases for plugin system
- Documentation supplements
- Starter templates

**Expected locations:**
- `packages/quereus-plugin-*` directories
- Example plugins in docs or samples

## 2. Assessment Criteria

### Code Quality

1. **Best Practices**
   - Do samples follow best practices?
   - Are they idiomatic for the plugin API?
   - Do they handle errors properly?

2. **Documentation**
   - Are samples well-documented?
   - Are they easy to understand?
   - Do they explain patterns?

3. **Completeness**
   - Do they demonstrate all features?
   - Are edge cases shown?
   - Are advanced patterns included?

### Coverage

What plugin types should be demonstrated?

- Scalar function plugin
- Aggregate function plugin
- Table-valued function plugin
- Virtual table module plugin
- Collation plugin
- Event handler plugin

## 3. Files to Review

### Each Sample Plugin

For each sample:
- Entry point file
- Type definitions
- README/documentation
- Tests

### Cross-Cutting

- Shared utilities across samples
- Build configuration
- Testing approach

## 4. Review Checklist per Sample

- [ ] Has clear purpose
- [ ] Has README with usage
- [ ] Has working code
- [ ] Has tests
- [ ] Demonstrates best practices
- [ ] Handles errors properly
- [ ] Has type definitions
- [ ] Is up to date with API

## 5. Test Coverage

### Sample Plugin Tests

Each sample should have:
- Basic functionality tests
- Edge case tests
- Error handling tests
- Integration tests

```typescript
// test/sample-plugin/basic.spec.ts
describe('Sample Plugin', () => {
  it('loads correctly')
  it('provides expected functionality')
  it('handles errors gracefully')
})
```

## 6. Documentation Requirements

### Per Sample

1. **README.md**
   - Purpose
   - Installation
   - Usage
   - API reference

2. **Code Comments**
   - Explain non-obvious code
   - Document patterns
   - Reference main docs

3. **Examples**
   - Simple usage
   - Advanced usage
   - Integration examples

## 7. TODO

### Phase 1: Inventory
- [ ] List all sample plugins
- [ ] Document each plugin's purpose
- [ ] Check documentation status
- [ ] Check test status

### Phase 2: Quality Review
- [ ] Review each plugin's code
- [ ] Verify best practices
- [ ] Check error handling
- [ ] Verify type safety

### Phase 3: Testing
- [ ] Add missing tests
- [ ] Verify tests pass
- [ ] Add edge case tests

### Phase 4: Documentation
- [ ] Update/create READMEs
- [ ] Add code comments
- [ ] Create usage examples
- [ ] Link from main docs
