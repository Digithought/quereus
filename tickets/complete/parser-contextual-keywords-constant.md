description: DRY refactor extracting repeated contextual-keyword arrays to a module-level constant in the parser
files:
  packages/quereus/src/parser/parser.ts   # CONTEXTUAL_KEYWORDS constant + ~20 call sites
  packages/quereus/test/parser.spec.ts     # new "Contextual keywords as identifiers" regression block
----

## What shipped

Pure DRY refactor of `packages/quereus/src/parser/parser.ts`. The 11-element array
`['key','action','set','default','check','unique','references','on','cascade','restrict','like']`,
previously re-allocated inline or as a local `const` at ~20 sites, is now a single
module-level constant:

```typescript
const CONTEXTUAL_KEYWORDS = ['key', 'action', 'set', 'default', 'check', 'unique', 'references', 'on', 'cascade', 'restrict', 'like'] as const;
```

All base-set sites reference `CONTEXTUAL_KEYWORDS` directly. Two methods extend it via spread:
- `tableIdentifier`: local `[...CONTEXTUAL_KEYWORDS, 'temp', 'temporary']` (referenced 5×).
- `primary` function-call path: inline `[...CONTEXTUAL_KEYWORDS, 'replace']`.

Because `as const` yields a `readonly` tuple, five private read-only helper signatures were widened
from `string[]` to `readonly string[]` (`consumeIdentifier` overload+impl,
`consumeIdentifierOrContextualKeyword`, `checkIdentifierLike`, `checkIdentifierLikeAt`,
`isContextualKeywordAvailable`).

## Review findings

### Verified correct
- **All base-set sites folded.** `grep` for the full literal (`'cascade', 'restrict', 'like'`) over
  the current file returns exactly one hit: the constant definition on line 45. No stray copies of
  the 11-element array survive. (Note: the `mcp__code-search` index was stale at review time —
  pre-commit — so verification was done with `grep` against the working tree, not the index.)
- **Self-reference near-miss is clean.** Line 45 RHS is the real literal, not
  `CONTEXTUAL_KEYWORDS as const` — the clobber the implementer flagged was correctly fixed.
- **`readonly` widening is safe.** All five widened helpers are `private` and only iterate the array
  (`for...of` against `TokenType`); none mutate it, and no caller passes the constant somewhere it is
  later mutated. `readonly string[]` is the more correct type. `yarn typecheck` confirms type-level
  soundness.
- **Spread sites type-check correctly.** `[...CONTEXTUAL_KEYWORDS, 'replace']` /
  `[...CONTEXTUAL_KEYWORDS, 'temp', 'temporary']` produce mutable `string[]`, assignable to the
  `readonly string[]` params.
- **Duplication is fully contained.** A repo-wide search (`packages/quereus/src`) finds the keyword
  array only in `parser.ts` — no sibling file (emitter, second parser) holds a duplicate that should
  have shared the constant. Scope of the refactor was correct.
- **Behavior unchanged.** Full suite green (see Validation). A typo in the single constant would
  break dozens of existing tests across `.sqllogic` and parser specs, so the existing suite already
  guards the constant's value.

### Found and fixed inline (minor)
- **Test coverage raised (the implementer's flagged "floor").** Added a `Contextual keywords as
  identifiers` block to `test/parser.spec.ts` (7 cases) that directly guards the constant and both
  extended sets: contextual keyword as qualified column ref, as column alias, as a table-valued
  function name (base set), `replace(...)` scalar call (function-call spread), `temp.foo` +
  bare `temporary` (tableIdentifier spread), and a contextual keyword as a CTE name. Previously these
  spread-path behaviors were only covered transitively.

### Found, filed as follow-up (out of scope — pre-existing)
- **Narrower CTE keyword subset.** `commonTableExpression` (parser.ts ~line 291) uses a hand-written
  7-element subset omitting `references`/`on`/`cascade`/`restrict`, so `select * from references`
  parses but `with references as (...)` does not. This is **pre-existing** (the refactor never
  touched those lines) and folding it into the constant would *change* behavior, so it was correctly
  left alone. Filed `tickets/backlog/parser-cte-contextual-keyword-subset.md`. A characterization test
  (`documents narrower CTE set`) pins the current behavior so a future fix is a deliberate test change.

### Checked, nothing to do
- **Docs.** This is a behavior-preserving internal refactor with no public-surface or grammar change;
  `docs/sql.md` and the parser docs describe SQL semantics, not the internal keyword-array structure,
  so no doc updates were warranted.
- **Error handling / resource cleanup / async / performance.** No new error paths, allocations
  removed not added (one shared frozen-ish constant vs. ~20 per-call allocations — a marginal
  improvement), no async or resource surface touched.

### Noted, not actioned (incidental observation, not from this diff)
- `this.error(...)` (the parser's generic error helper) throws a base `QuereusError`, not the
  `ParseError` subclass that some entry-point tests expect — a separate, unrelated inconsistency. Not
  in scope here; my CTE characterization test asserts on the error *message* (`/CTE name/`) to avoid
  coupling to it. Left for a future cleanup if it becomes relevant; not worth a ticket on its own.

## Validation
- `yarn typecheck` (tsc --noEmit): pass
- `yarn lint`: pass
- `yarn test`: 3683 → after new tests, full suite green (51 in parser.spec.ts, 0 failing)
- `yarn test:store` not run — refactor does not touch the store path; AST is behavior-identical.
