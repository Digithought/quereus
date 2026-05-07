description: SQL single-quoted string-literal parser drops backslashes — backslashes inside `'...'` should be preserved literally per the SQL standard.
prereq:
files:
  packages/quereus/test/logic/18-json-string-escapes.sqllogic
  packages/quereus/src/parser/lexer.ts
  packages/quereus/src/parser/parser.ts
----

## Problem

Quereus's SQL string-literal lexer/parser silently strips backslash
characters from single-quoted string literals when the backslash isn't
followed by a recognized escape sequence. This violates the SQL
standard, which says single-quoted strings have no escape processing
other than `''` for an embedded single quote — every other character
(including `\`) must be preserved verbatim.

The bug surfaced in the JSON cross-check fixture
`packages/quereus/test/logic/18-json-string-escapes.sqllogic`, where
multiple cases that try to construct JSON strings containing escape
sequences cannot even be expressed in SQL because the SQL parser
mangles the literal before the JSON function ever sees it.

Symptoms (each commented `-- TODO bug:` in the fixture):

- `'"\ '` (line 11–13) — the backslash before the space is dropped, so
  the literal becomes `'" '` rather than `'"\ '`.
- `'a\\b'` (line 32–34) — `json_array('a\\b')` should round-trip a
  literal backslash, but the parser strips one or both, so the
  resulting JSON contains no backslash.
- Lines 46–66 (5 cases) — `json_extract` with a JSON document
  containing `\"`, `\\`, `\n`, `\t` cannot be tested from SQL because
  the SQL-source string is stripped of backslashes before the JSON
  function parses it.
- Lines 78–82 (2 cases) — `json_valid` with malformed JSON escape
  sequences (`\xZZ`, `\u00`) cannot be constructed from SQL source for
  the same reason.

All eight commented cases reduce to the single root bug: the
SQL string-literal scanner is processing `\` as an escape lead-in.

## Expected behavior

Per the SQL standard (and SQLite's behavior — the cross-check source):

- Single-quoted string literals contain the bytes between the quotes
  verbatim, with one exception: a doubled single quote `''` represents
  a single literal `'`.
- Backslash has no special meaning. `'a\nb'` is a five-character string
  `a`, `\`, `n`, `b` (four chars actually: `a`, `\`, `n`, `b`).
  Quereus currently produces three: `a`, `n`, `b`.

After the fix, every commented `-- TODO bug:` case in
`18-json-string-escapes.sqllogic` should be uncomment-able and pass.

## Reproduction

```
cd C:\projects\quereus
yarn workspace @quereus/quereus test --grep "18-json-string-escapes"
```

Then uncomment any of the `-- TODO bug:` blocks in
`packages/quereus/test/logic/18-json-string-escapes.sqllogic` (lines
11–13, 32–34, 46–66, 78–82) and re-run — each will fail with the
backslash-stripped literal showing up wherever Quereus's value flows
out.

A minimal one-liner reproducer outside the JSON context:

```sql
select length('a\b') as n;
-- expected: [{"n":3}]
-- actual:   [{"n":2}]
```

## Likely investigation areas

- `packages/quereus/src/parser/lexer.ts` — string-literal token
  scanner; check whether the single-quote scanning loop has an
  unintended `\` escape-handling branch (perhaps copied from a
  double-quoted-identifier or C-style string scanner).
- `packages/quereus/src/parser/parser.ts` — verify that the parser's
  string-literal node-construction path doesn't post-process the
  scanner's output to interpret escapes.
- Audit fixture impact: any other `.sqllogic` test that uses
  `\` inside `'...'` will be affected. A grep for `'\\` across
  `packages/quereus/test/logic/` will surface candidates that may need
  re-validation after the fix.

## Cross-references

Surfaced during the
`tickets/complete/5-sqlite-xref-functions-temporal-json.md` review pass
(see also the implement log at
`tickets/.logs/5-sqlite-xref-functions-temporal-json.implement.*.log`).
The fixture cases this ticket targets are commented `-- TODO bug:`
inline so reviewers can see the intent and uncomment them in the
verification pass.
