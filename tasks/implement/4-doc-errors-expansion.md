---
description: Expand docs/errors.md with full error reference
dependencies: docs/errors.md, packages/quereus/src/common/errors.ts, packages/quereus/src/common/types.ts
files:
  - docs/errors.md
  - packages/quereus/src/common/errors.ts
  - packages/quereus/src/common/types.ts
  - packages/quereus/src/parser/parser.ts
---

## Architecture

`docs/errors.md` is currently 56 lines — a brief overview without actionable reference content. Expand it into a complete error reference while preserving the existing structure.

### Content to Add

**StatusCode Table** — Add a complete table of all 31 StatusCode enum values (from `src/common/types.ts`) with when each is used:
- `OK` (0), `ERROR` (1), `INTERNAL` (2), `PERM` (3), `ABORT` (4), `BUSY` (5), `LOCKED` (6), `NOMEM` (7), `READONLY` (8), `INTERRUPT` (9), `IOERR` (10), `CORRUPT` (11), `NOTFOUND` (12), `FULL` (13), `CANTOPEN` (14), `PROTOCOL` (15), `EMPTY` (16), `SCHEMA` (17), `TOOBIG` (18), `CONSTRAINT` (19), `MISMATCH` (20), `MISUSE` (21), `NOLFS` (22), `AUTH` (23), `FORMAT` (24), `RANGE` (25), `NOTADB` (26), `NOTICE` (27), `WARNING` (28), `SYNTAX` (29), `UNSUPPORTED` (30)
- Group by commonly used vs. reserved/rare

**ParseError Details** — Expand the ParseError entry:
- Constructor: `new ParseError(token, message)` — extracts line/column from Token position
- The `token` property for inspecting the offending token
- Example of catching and inspecting ParseError

**Error Chain Examples** — Add code examples showing:
- Using `unwrapError()` to get an `ErrorInfo[]` chain
- Using `formatErrorChain()` for display
- Using `getPrimaryError()` for the outermost error
- Pattern for wrapping external errors with context

**Common Error Patterns** — Add a section with common error categories and how to handle them:
- Syntax errors (parsing phase) — ParseError
- Semantic errors (planning phase) — QuereusError with ERROR code (table not found, column ambiguity, type mismatch)
- Constraint violations (data layer) — ConstraintError with CONSTRAINT code
- API misuse (contract violations) — MisuseError with MISUSE code
- Runtime errors from UDFs/VTabs — wrapped QuereusError with context message

## TODO

- [ ] Add StatusCode enum table after "QuereusError Structure" section
- [ ] Expand ParseError entry in "Error Class Hierarchy" with constructor details and token property
- [ ] Add "Error Chain Examples" section with code samples for unwrapError/formatErrorChain/getPrimaryError
- [ ] Add "Common Error Patterns" section organized by error phase/category
