description: Updated EBNF grammar and prose in docs/sql.md to match parser implementation
dependencies: docs/sql.md, packages/quereus/src/parser/parser.ts
files: docs/sql.md
----

## Summary

Updated the EBNF grammar (section 12) and related prose in `docs/sql.md` to accurately reflect the current parser implementation.

## EBNF Changes

- **INSERT**: Added `OR conflict_resolution`, `upsert_clause` (ON CONFLICT DO NOTHING/UPDATE), and `with_schema_clause`
- **UPDATE/DELETE**: Added `with_schema_clause`
- **SELECT**: Added `with_schema_clause` to `simple_select`
- **context_clause**: Fixed to use no-parens DML assignment form; added separate `context_def_clause` for CREATE TABLE definitions
- **CREATE TABLE**: Added `context_def_clause` for WITH CONTEXT variable definitions
- **ALTER TABLE**: Added `add_constraint_stmt`
- **ANALYZE**: Added missing `analyze_stmt` production and reference in `sql_statement`
- **DECLARE SCHEMA**: Full syntax with `schema_name`, VERSION, USING options, brace-delimited body, SEED items
- **DIFF/APPLY/EXPLAIN SCHEMA**: Added `schema_name` arguments and optional clauses (TO VERSION, WITH SEED, OPTIONS)
- **binary_operator**: Added `"xor"`
- **conflict_clause**: Refactored to reference shared `conflict_resolution` production
- **join_operator**: Added `"lateral"` keyword support

## Prose Changes

- **Section 3.5 ORDER BY**: Added NULLS FIRST/LAST syntax and example (was already in EBNF ordering_term but missing from prose)
- **Section 11.2.3 comparison table**: Fixed Foreign Keys row from "Parsed but not enforced" to "Supported (via `pragma foreign_keys = on`)" to match section 7.6

## Testing & Validation

- Build passes
- All tests pass (docs-only change)
- Cross-referenced EBNF against parser source (parser.ts) for accuracy
