description: CTE name/column list now shares the full CONTEXTUAL_KEYWORDS set (was a narrower 7-element subset) — reviewed and complete
files:
  packages/quereus/src/parser/parser.ts   # commonTableExpression (~line 293, 301)
  packages/quereus/test/parser.spec.ts     # "Contextual keywords as identifiers" describe block
  packages/quereus/src/emit/ast-stringify.ts # withClauseToString / quoteIdentifier (round-trip path, verified not edited)
----

## Summary

`commonTableExpression` now references the shared module-level `CONTEXTUAL_KEYWORDS` constant at
both identifier sites (CTE name and CTE column list) instead of a hand-written 7-element subset.
The four previously-omitted keywords — `references`, `on`, `cascade`, `restrict` — are now accepted
as unquoted CTE names and CTE column names, matching how they were already accepted as table names
everywhere else. This resolves the asymmetric inconsistency the original ticket documented:

```sql
select * from references;                               -- already parsed
with references as (select 1) select * from references; -- now parses too (previously threw)
```

This is a deliberate widening for internal consistency (every identifier context shares the same
reserved-but-table-legal set), not a strict-SQLite-parity change — `references`/`on` were already
table-legal in this engine, so the CTE path is now consistent with a choice made elsewhere.

## Review findings

**Scope reviewed:** the implement-stage diff (`d08b401c`), the full set of `CONTEXTUAL_KEYWORDS`
call sites in `parser.ts`, the CTE emit path in `ast-stringify.ts`, and the test changes.

- **Correctness / consistency (checked, no issue):** The two edited lines are byte-for-byte
  identical in form to the ~20 other `consumeIdentifier(CONTEXTUAL_KEYWORDS, ...)` call sites
  (table identifiers, column defs, view/subquery/function column lists, ALTER actions, SET
  clauses, identifier lists). The CTE path is now genuinely uniform with the rest of the parser.
  No new syntax, no AST shape change — CTE name/columns remain plain strings.

- **Parse ambiguity (checked, none):** `commonTableExpression` is only entered immediately after
  `with` or after a list comma; it consumes the name then expects `(` or `AS`. Admitting `on`,
  `references`, etc. as the leading token introduces no ambiguity with any other construct in that
  position. Verified `on` explicitly (`with on as (...)`), not just transitively.

- **Emitter round-trip (checked, safe — was flagged as an open gap by the implementer):**
  `withClauseToString` emits the CTE name and columns via `quoteIdentifier`, which quotes any
  lexer keyword. `references`/`on`/`cascade`/`restrict` are all lexer keywords (that is *why* they
  must live in `CONTEXTUAL_KEYWORDS`), so they emit quoted (`with "references" as ...`) and the
  widened parser accepts them on re-parse. The implementer's "worth a quick sanity check" gap is
  now closed by a durable assertion. No emitter edit was needed.

- **Type safety / resource cleanup / error handling (checked, n/a):** Change is a constant
  reference swap in a pure parser method; no new resources, no new error paths, no `any`.

- **Test coverage — minor gaps fixed inline:**
  - Added `round-trips a keyword-named CTE through ast-stringify` — asserts `parse(astToString(...))`
    preserves a CTE named `references`. This covers the previously-untested emit path (the only
    place a real latent bug could have hidden).
  - Added explicit `on`-as-CTE-name coverage to the CTE-name test (was only covered transitively
    via sharing the constant).
  - Existing happy-path coverage for `key` (name), `references` (name), and `cascade`/`restrict`
    (column list) retained.

- **Deliberate non-addition (documented, not fixed):** No `.sqllogic` runtime case was added for
  keyword-named CTEs. CTE name/column resolution in the planner/runtime is identifier-string-generic
  — it does not special-case keyword spellings — and the implementer already smoke-verified runtime
  resolution end-to-end via `db.eval`. A sqllogic test here would exercise generic plumbing for a
  near-zero marginal risk; the parser + round-trip coverage is the appropriate floor. No `major`
  follow-up ticket warranted.

- **Docs (checked, no change needed):** The change adds no new SQL syntax and does not alter any
  documented behavior surface (`docs/sql.md`, parser header comment). The parser.ts header warning
  about mirroring syntax changes into the emitters was honored by verification (round-trip), not
  by edit, since no syntax was added.

## Validation

- `parser.spec.ts` "Contextual keywords as identifiers": 9 passing (incl. 2 new assertions).
- Full `@quereus/quereus` suite (`node test-runner.mjs`): **3711 passing**, 9 pending, exit 0.
- `yarn lint`: clean, exit 0.
- Pre-existing `[property-planner] Rule '…' never fired` console notices are informational and
  unrelated to this diff.
