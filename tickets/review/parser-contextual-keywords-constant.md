description: Review DRY refactor extracting repeated contextual-keyword arrays to a module-level constant in the parser
prereq: none
files:
  packages/quereus/src/parser/parser.ts
----

## What changed

Pure DRY refactor of `packages/quereus/src/parser/parser.ts`. The 11-element array
`['key', 'action', 'set', 'default', 'check', 'unique', 'references', 'on', 'cascade', 'restrict', 'like']`
was re-allocated as a local `const` (or inlined as a call argument) in ~20 places. It is now a
single module-level constant:

```typescript
const CONTEXTUAL_KEYWORDS = ['key', 'action', 'set', 'default', 'check', 'unique', 'references', 'on', 'cascade', 'restrict', 'like'] as const;
```

All base-set sites now reference `CONTEXTUAL_KEYWORDS` directly (local `const contextualKeywords`/`colKeywords`
declarations removed). Two methods extend the set via spread:

- `tableIdentifier` (line ~810): `const contextualKeywords = [...CONTEXTUAL_KEYWORDS, 'temp', 'temporary'];`
  — kept a local because it is referenced 5× and builds an extended array.
- `primary` function-call path (line ~1644/1645): inline `[...CONTEXTUAL_KEYWORDS, 'replace']`.

### Signature widening (the one non-trivial design choice)

`as const` makes the constant a `readonly` tuple, which is **not** assignable to a `string[]` parameter.
So five parser helper signatures were widened from `string[]` to `readonly string[]`:

- `consumeIdentifier` (overload + impl)
- `consumeIdentifierOrContextualKeyword`
- `checkIdentifierLike`
- `checkIdentifierLikeAt`
- `isContextualKeywordAvailable`

This is safe because **all five only iterate (read) the array** (`for...of` lookups against `TokenType`);
none mutate it. `readonly string[]` is the more correct type regardless. Reviewer: please confirm no
external caller relied on passing a mutable array out of these (they're all `private`).

## Use cases for validation (behavior must be UNCHANGED — this is a refactor)

The constant feeds every context where a tokenized-but-contextual keyword may appear as an identifier.
Smoke-parse SQL exercising each, confirming the keyword is accepted as an identifier and the AST is identical
to pre-refactor:

- **Column / alias lists**: `select * from t(key, action, "set")`, `select x as "default" from t`
- **Table / schema names**: `select * from "references"."on"`, `select * from check_tbl`
- **Function-call source & function name**: `select * from like(1)`, `select replace('a','a','b')` (the `'replace'` extra)
- **`temp`/`temporary` as names**: `select * from temp.foo`, table named `temporary` (the `tableIdentifier` extra)
- **Qualified column refs**: `select cascade.restrict from cascade` (schema.table.column / table.column / bare paths in `primary`)
- **SET clause** (UPDATE): `update t set "on" = 1`
- **CREATE VIEW column list**: `create view v(key, "set") as select ...`
- **ALTER TABLE**: `rename column "key" to "default"`, `rename to "references"`, `drop column "on"`, add-column PK list
- **DECLARE table** name, **identifier lists** (both plain and with-direction)
- **Missing-comma error path** in CREATE TABLE element list (`alterColumnAction`, the multi-`peekKeyword` guard)

The full `yarn test` suite (3683 cases) covers the above paths via `.sqllogic` and parser specs; all pass.

## Known gaps / things for the reviewer to scrutinize

- **Different 7-keyword subset left untouched (intentional, possible latent inconsistency).**
  `commonTableExpression` (lines ~285/293, CTE name + CTE column list) uses a *smaller* set:
  `['key', 'action', 'set', 'default', 'check', 'unique', 'like']` — missing `references`, `on`,
  `cascade`, `restrict`. This is **out of scope** for this ticket (different set) and was deliberately
  NOT folded into the constant, since doing so would change what identifiers a CTE accepts. Reviewer
  decision: is the narrower CTE set intentional, or a pre-existing inconsistency worth a follow-up
  ticket? (Not addressed here either way.)
- **Near-miss caught during implementation:** a global find/replace of the bare literal initially
  clobbered the constant's *own definition* (`const CONTEXTUAL_KEYWORDS = CONTEXTUAL_KEYWORDS as const;`).
  It was fixed before validation; line 45 is the place to eyeball that the RHS is the real literal.
- No new tests were added — this is a behavior-preserving refactor and the existing suite already
  exercises every affected parse path. If the reviewer wants belt-and-suspenders, a focused
  "contextual keyword as identifier in every context" parser spec would be the floor to raise.

## Verification performed
- `yarn typecheck` (tsc --noEmit): pass
- `yarn lint`: pass
- `yarn test`: 3683 passing, 9 pending, 0 failing
- (Not run: `yarn test:store` — refactor does not touch the store path; behavior-identical AST.)
