description: CTE name/column list now shares the full CONTEXTUAL_KEYWORDS set (was a narrower 7-element subset) — implemented, needs review
files:
  packages/quereus/src/parser/parser.ts   # commonTableExpression (~line 293, 301)
  packages/quereus/test/parser.spec.ts     # "Contextual keywords as identifiers" describe block (~line 401-420)
----

## What changed

The human decision on the open question ("Is the narrower CTE set intentional?") was
**no — it shouldn't be narrowed**. So `commonTableExpression` now references the shared
module-level `CONTEXTUAL_KEYWORDS` constant at both identifier sites (CTE name and CTE column
list), instead of its hand-written 7-element subset
`['key','action','set','default','check','unique','like']`.

Net effect: the four previously-omitted keywords — `references`, `on`, `cascade`, `restrict` —
are now accepted as unquoted CTE names and CTE column names, matching how they were already
accepted as table names everywhere else. This removes the asymmetric inconsistency the ticket
documented:

```sql
select * from references;                               -- already parsed
with references as (select 1) select * from references; -- now parses too (previously threw "Expected CTE name.")
```

## Rationale / scope note

This is a deliberate behavior change (a widening), not a refactor — which is exactly why the
prior `parser-contextual-keywords-constant` DRY pass left it out. The goal here is **internal
consistency** within this engine: the set of reserved-but-table-legal identifiers should be the
same in every identifier context.

Caveat for the reviewer on SQLite parity: strict SQLite actually reserves `references`/`on` and
would reject them as *both* table names and CTE names. This engine has already chosen to accept
them as table-legal identifiers (they live in `CONTEXTUAL_KEYWORDS`), so this change does not
introduce a new divergence from SQLite — it makes the CTE path consistent with a choice the
engine had already made elsewhere. If a reviewer instead wants strict SQLite parity, that is a
separate, larger decision about the whole `CONTEXTUAL_KEYWORDS` set, not this ticket.

## Test changes

In `parser.spec.ts`, "Contextual keywords as identifiers" block:
- Renamed `accepts a contextual keyword as a CTE name (CTE subset)` →
  `(shared CONTEXTUAL_KEYWORDS set)` (label only; body unchanged — still uses `"key"`).
- **Flipped** the former characterization test `rejects an unquoted reserved-but-table-legal
  keyword as a CTE name (documents narrower CTE set)` into
  `accepts a previously-omitted reserved-but-table-legal keyword as a CTE name`. It now asserts
  `with references as (...)` parses and `ctes[0].name === 'references'`, and that the same word
  is still accepted as a table name (symmetry).
- **Added** `accepts a previously-omitted reserved-but-table-legal keyword in a CTE column list`
  — covers the *second* edited site: `with c(cascade, restrict) as (...)` parses with
  `columns === ['cascade', 'restrict']`.

## Validation performed

- `parser.spec.ts`: 60 passing (incl. the 3 above).
- Full `@quereus/quereus` suite (`yarn test`): 3710 passing, 9 pending, exit 0.
- `yarn lint` (quereus): clean, exit 0.
- End-to-end smoke (ad-hoc `db.eval`, not committed): `with references as (select 1 as a) select a from references`
  returns `[{a:1}]`; `with c(cascade, restrict) as (select 1, 2) select cascade, restrict from c`
  returns `[{cascade:1, restrict:2}]`. Confirms it's not just a parse-level change — name/column
  resolution works through the planner/runtime.

## Known gaps / what to scrutinize

- **No committed sqllogic test.** Runtime resolution was only verified via an ad-hoc inline
  `db.eval` (results above), not a `.sqllogic` case in the standard suite. If the reviewer wants
  durable runtime coverage for CTEs named with these keywords, add a small case under
  `test/logic/`. The parser-level coverage is the floor, not a ceiling.
- **Emitter round-trip not explicitly re-checked for these keywords.** The parser.ts header
  warns that syntax changes must be mirrored in `emit/ast-stringify.ts`, `schema/catalog.ts`,
  and `quereus-store/.../ddl-generator.ts`. This change adds no new *syntax* — only widens which
  existing identifier tokens are accepted — and the CTE name/columns are plain strings in the AST
  that already round-trip, so no emitter edit was needed. Worth a quick sanity check that an
  `astToString` round-trip of `with references as (...) ...` reproduces the keyword (the existing
  materialized-view round-trip tests pass, but none specifically exercises a keyword-as-CTE-name).
- Only `references`/`cascade`/`restrict` are exercised by name in the new tests; `on` is covered
  transitively by sharing the constant but has no dedicated assertion.
