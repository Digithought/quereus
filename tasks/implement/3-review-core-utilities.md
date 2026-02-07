---
description: Comprehensive review of utility modules (comparison, coercion, helpers)
dependencies: none
priority: 3
---

# Utilities Subsystem Review

## Goal

Conduct adversarial review of utility modules to ensure SQLite compatibility, correct type handling, and robust error handling. Verify comparison semantics, coercion accuracy, and utility reliability.

## Scope

- **Comparison**: Value comparison with affinity rules (`src/util/comparison.ts`)
- **Coercion**: Type coercion utilities (`src/util/coercion.ts`)
- **Debug**: Debug logging utilities (`src/util/debug.ts`)
- **Hermes**: Hermes JS engine compatibility (`src/util/hermes.ts`)
- **Plugin helper**: Plugin registration helpers (`src/util/plugin-helper.ts`)
- **Logging**: Logging infrastructure (`src/util/log.ts`)
- **Errors**: Error handling utilities (`src/common/errors.ts`)

## Non-goals

- Runtime execution utilities (see `3-review-core-runtime.md`)
- Planner utilities (see `3-review-core-planner.md`)

## Checklist

### Comparison Module

- [ ] **NULL semantics**: Confirm how NULL participates in comparison and sorting (three-valued logic vs total ordering) and ensure behavior is consistent across runtime + vtab + planner assumptions.
- [ ] **Affinity rules**: Validate `packages/quereus/src/util/comparison.ts` matches intended SQLite semantics for mixed-type comparisons (e.g. numeric text vs number), including type ordering rules.
- [ ] **Collations**: Confirm supported collations (NOCASE/BINARY/RTRIM) and ensure they are applied consistently in comparisons and index constraint evaluation.
- [ ] **Edge cases**: Add/extend tests for Infinity, NaN, empty strings/blobs, and numeric boundary strings.

### Coercion Module

- [ ] **Conversion semantics**: Validate `packages/quereus/src/util/coercion.ts` against intended SQLite behavior (numeric parsing, truncation rules, whitespace, locale assumptions).
- [ ] **Scientific notation**: Ensure numeric parsing covers `1e+10` / `1E10` forms and rejects invalid variants predictably.
- [ ] **Blob hex parsing**: Confirm supported hex syntaxes and edge cases (odd-length, casing, invalid characters).
- [ ] **Error behavior**: Standardize what constitutes an “expected” conversion failure vs a programmer error. Avoid swallowing exceptions; prefer explicit return types or typed errors.
- [ ] **Datetime parsing**: Confirm supported date/time formats and time zone handling; add tests that lock in behavior.

### Code Quality

- [ ] **Type guard reuse**: Identify duplicated type checks and consider consolidating (only if it reduces subtle inconsistency risk).
- [ ] **Comparison decomposition**: If `compareValues()` is hard to reason about, propose an incremental refactor that improves readability without changing semantics.
- [ ] **Debug/log ergonomics**: Confirm debug logging utilities are consistent across runtime and packages and are controllable via env/config.
- [ ] **Error utility consistency**: Ensure helper utilities in `packages/quereus/src/common/errors.ts` are used consistently and preserve causes/stacks.

### Test Coverage

- [ ] **Comparison tests**: Add/extend tests under `packages/quereus/test/` for same-type comparisons, NULL handling, affinity rules, collations, and edge cases.
- [ ] **Coercion tests**: Add/extend tests under `packages/quereus/test/` for numeric parsing, coercion behaviors, blob parsing, and datetime parsing.
- [ ] **Utility tests**: Add tests under `packages/quereus/test/` for debug, plugin-helper, and logging utilities.

### Documentation

- [ ] **Add JSDoc**: Document all exported functions with signatures, parameters, return values, error conditions.
- [ ] **SQLite compatibility notes**: Document where behavior matches SQLite, intentional differences, migration considerations.
- [ ] **Usage examples**: Add examples for common patterns, edge cases, best practices.

## Deliverables

1. **Fixed comparison**: NULL semantics corrected, affinity rules verified
2. **Refactored coercion**: Decomposed by target type, error handling standardized
3. **Type guard utilities**: Shared type checking functions
4. **Test suites**: Comprehensive comparison and coercion tests
5. **Documentation**: JSDoc, SQLite compatibility notes, usage examples

## Test Plan

### Unit Tests

- **Comparison**: Same type comparisons, NULL handling (three-valued logic), affinity rules, collation (NOCASE, BINARY, RTRIM), edge cases (Infinity, NaN, empty values)
- **Coercion**: To INTEGER (strings, truncation, scientific notation, boundaries), to REAL, to TEXT, to BLOB (hex parsing, case sensitivity), to DATETIME (ISO, SQLite, timezones)
- **Utilities**: Debug namespacing, plugin registration, logging levels

### Integration Tests

- **SQLite compatibility**: Side-by-side tests with SQLite for comparison and coercion behavior
- **Performance**: Benchmark comparison and coercion operations

### Logic Tests

- Add SQL logic tests for utility correctness (`test/logic/14-utilities-*.sqllogic`):
  - Comparison edge cases
  - Coercion edge cases
  - NULL handling
  - Type affinity

## Acceptance Criteria

- Comparison + coercion semantics are clearly defined (SQLite-compatible where intended, deviations explicitly documented)
- Focused regression tests cover NULL/affinity/collation edge cases and common coercions
- Error behavior is consistent and does not swallow unexpected exceptions

## Notes/Links

- SQLite type affinity: https://www.sqlite.org/datatype3.html
- SQLite comparison: https://www.sqlite.org/lang_expr.html#collation