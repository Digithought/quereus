description: SQL single-quoted string literal lexer was stripping backslashes (treating `\n`, `\t`, `\\`, etc. as C-style escapes). Now backslashes are preserved verbatim per the SQL standard; only `''` remains as the embedded-quote escape.
files:
  packages/quereus/src/parser/lexer.ts (string() method, lines 493–522)
  packages/quereus/test/logic/18-json-string-escapes.sqllogic (uncommented and verified previously-blocked cases)
----

## What was built

Replaced the C-style escape-handling in `Lexer.string()` with the
SQL-standard rule: characters between the quotes are preserved
verbatim, with one exception — a doubled quote (`''`) inside a
single-quoted string represents a single literal quote. Backslashes,
newlines, tabs, etc. are no longer interpreted; whatever bytes appear
between the delimiting quotes become the string's value.

Before the fix, the scanner had a switch on `\n`, `\r`, `\t`, `\\`,
`\'`, `\"`, `\0` (and silently dropped the leading `\` for any other
following character — that's the behavior the cross-check fixture
caught). After the fix the scanner is a tight read-until-quote loop
with a single doubled-quote re-entry, and produces the same token type
and value-shape as before for everything except backslash sequences.

## Use cases & validation

The cross-check fixture
`packages/quereus/test/logic/18-json-string-escapes.sqllogic` had eight
cases commented out as `-- TODO bug:` because the lexer was mangling
their inputs before any JSON function saw them. They are now active
and passing:

- `json_quote('String "\ Test')` — backslash-before-space preserved.
- `json_array('a\\b')` — backslash round-trips literally; output is
  `["a\\\\b"]` (the source has two literal backslashes; JSON encodes
  each as `\\`, so four `\` characters appear in the JSON form).
- `json_extract('{"a":"he said \"hi\""}', '$.a')` — embedded JSON `\"`
  reaches the JSON parser intact.
- `json_extract` with `\\`, `\n`, `\t` payloads — all four standard
  JSON escape sequences round-trip.
- `json_valid('{"a":"\xZZ"}')` and `json_valid('{"a":"\u00"}')` —
  malformed JSON escapes are rejected (`json_valid` returns `false`),
  which would have been impossible to express in SQL source under the
  old lexer.

Verification:

- `yarn workspace @quereus/quereus test --grep "18-json-string-escapes"`
  → 1 passing.
- `yarn workspace @quereus/quereus test --grep "Parser"` → 59 passing
  (the parser unit tests use `'a' || 'b' || 'c'`, `'hello'`, `'one'`,
  `'pos'/'neg'` — none of which contain backslashes, so no regressions
  there).
- Full `yarn workspace @quereus/quereus test` → 993 passing, 1
  pre-existing failure in `Predicate normalizer / double negation` that
  reproduces on `main` without any of these changes (unrelated).

Backwards-compat note: any external SQL relying on `\n`, `\t`, etc.
inside single-quoted strings will now see literal backslash sequences
instead of control characters. This matches SQLite, the SQL standard,
and the engine's stated cross-check behavior; it is a deliberate
correctness fix, not a regression.

## Review checklist

- [ ] `string()` no longer references `escaping`, `\\`, `\n`, etc. and
  is tighter than the previous version.
- [ ] No callers post-process `STRING` token literals to interpret
  escapes (parser.ts at the literal-construction sites just passes the
  token literal through — see lines around `parser.ts:1596` and
  `:1532`).
- [ ] Other `.sqllogic` fixtures don't depend on the old behavior — a
  grep for `'[^']*\\[^']*'` across `packages/quereus/test/logic/`
  surfaced only `18-json-string-escapes.sqllogic` and an expected
  output at `97-json-function-edge-cases.sqllogic:200` (which is the
  expected JSON output, not a SQL source string).
- [ ] Identifier scanners (`doubleQuotedIdentifier`,
  `backtickIdentifier`, `bracketIdentifier`) are untouched — they
  already preserved characters verbatim and never had the escape
  branch.
