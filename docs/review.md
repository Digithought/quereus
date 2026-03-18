# Systematic Code Review Protocol

This document defines the review protocol for systematic quereus code reviews.
Each review ticket references this document and covers a specific group of files.

## Aspect Checklist

Review each file in the unit against all of the following aspects:

### Correctness
- Logic errors, off-by-one, wrong operator, inverted conditions
- Missing or incorrect null/undefined handling
- Incorrect async/await usage (missing await, dangling promises)
- Race conditions in concurrent paths

### Type Safety
- Use of `any` where a proper type exists
- Unsafe casts (`as`) that could mask bugs
- Missing or incorrect generic constraints

### Resource Cleanup
- AsyncIterator/generator cleanup (break, return, finally)
- Event listener registration without corresponding removal
- Open handles (connections, cursors) not cleaned up on error paths

### Error Handling
- Swallowed exceptions (empty catch, catch without logging)
- Missing error paths in async flows
- Errors used as control flow (should use return values or specific patterns)
- Error messages that lose context (re-throwing without cause)

### DRY / Duplication
- Copy-paste code that should be extracted
- Repeated patterns that indicate a missing abstraction
- Near-identical switch/if branches

### Single Responsibility
- Functions/methods doing too many things
- God objects or classes with mixed concerns
- Side effects in unexpected places

### Performance
- Unnecessary allocations in hot paths
- O(n²) where O(n) or O(n log n) is possible
- Repeated lookups that could be cached
- Unnecessary array copies or spreads

### Edge Cases
- Empty inputs (empty arrays, empty strings, zero rows)
- Boundary conditions (max/min values, integer overflow)
- Single-element vs multi-element collections

### Cross-Platform
- Node-specific APIs used without browser/RN fallback
- Assumptions about file system, process, or environment

### API Surface / Encapsulation
- Internal details leaking through public interfaces
- Missing or incorrect visibility (export of internal helpers)
- Mutable state exposed without protection

## Severity Classification

- **defect**: Incorrect behavior, data corruption risk, resource leak, or crash. Requires a fix.
- **smell**: Code works but is fragile, hard to maintain, or violates principles. Should be addressed.
- **note**: Observation, minor improvement, or question. Low priority.

## Handling Findings

- **Trivial fixes** (typos, missing `void` prefix, obvious one-line corrections): fix directly in the review pass and note what was changed.
- **Non-trivial findings**: create a `fix/` or `plan/` ticket with the finding details, severity, file, and line reference. Don't attempt the fix during review.

## Output Format

When completing a review ticket, transition it to `complete/` with a summary structured as:

```
description: Review of <unit name>
files: <list of files reviewed>
----
## Findings

### <severity>: <short title>
file: <path>:<line>
<description of the issue and why it matters>
Ticket: <path to fix/plan ticket if non-trivial, or "fixed in review" if trivial>

## Trivial Fixes Applied
- <file>:<line> — <what was changed>

## No Issues Found
- <file> — clean
```
