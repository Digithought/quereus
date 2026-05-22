description: Fix parser precedence so prefix `not` binds *above* all predicates (`IN`, `BETWEEN`, `LIKE`, `IS [NOT] NULL`, comparison) instead of being lumped with arithmetic unary. Also tighten the stringifier so it cannot emit a round-trip-unsafe `not <predicate>` shape. Adds targeted sqllogic regressions for the parser path, the direct-DDL CHECK path, and the issue-#22 declarative-schema path.
prereq:
files:
  packages/quereus/src/parser/parser.ts
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/test/logic/02-filters.sqllogic
  packages/quereus/test/logic/40.2-check-extras.sqllogic
  packages/quereus/test/logic/50-declarative-schema.sqllogic
  packages/quereus/src/planner/analysis/predicate-normalizer.ts
  packages/quereus/src/planner/analysis/sat-checker.ts
  packages/quereus/src/planner/util/fd-utils.ts
  packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts
effort: high
----

## Background

GitHub issue [#22](https://github.com/gotchoices/quereus/issues/22) — a
`check (X not in (subquery))` constraint rejects every row after
`declare schema` / `apply schema`. The root cause is a parser precedence
bug independent of CHECK: prefix `NOT` is matched in `unary()`
(`packages/quereus/src/parser/parser.ts:1464-1471`) alongside arithmetic
`-` / `+` / `~`, so it binds *below* `comparison()` / `equality()` /
`isNull()`. The CHECK path lights it up because the stringifier
(`packages/quereus/src/emit/ast-stringify.ts:180-191`) emits
`unary NOT(InExpr)` as `not x in (...)` with no parens, and the
declarative-schema differ re-parses its own output.

Full root-cause analysis (parser walkthrough, evaluator-vs-standard
matrix, three-layer reproduction, adjacent-risk survey) lives in the
git history of the source fix ticket — see
`tickets/fix/2-fix-prefix-not-precedence-against-comparison.md` in the
commit that introduces this ticket. The TL;DR matrix:

| expression                       | quereus today | correct |
|----------------------------------|---------------|---------|
| `not 5 in (1,2,3)`               | false         | true    |
| `not 5 between 1 and 3`          | false         | true    |
| `not 'a' like 'b%'`              | false         | true    |
| `not null is null`               | true          | false   |
| `not 0 = 5`                      | false         | true    |

## Architecture

### Parser precedence — current vs. target

Current expression chain (`packages/quereus/src/parser/parser.ts`):

```
expression
  → logicalXorOr (OR/XOR)         line 1184
  → logicalAnd   (AND)            line 1195
  → isNull       (IS [NOT] NULL)  line 1206
  → equality     (=, ==, !=)      line 1227
  → comparison   (<, <=, …, IN, BETWEEN, LIKE, post-fix NOT)  line 1244
  → term         (+, -)           line 1442
  → factor       (*, /, %)        line 1453
  → unary        (-, +, ~, NOT)   line 1464   ← BUG: NOT lives here
  → concatenation (||) → collate → jsonPath → primary
```

Target chain — insert a dedicated NOT level immediately above `isNull`
(so `NOT` binds above every predicate, including `IS [NOT] NULL`, but
below `AND`/`OR`):

```
expression
  → logicalXorOr (OR/XOR)
  → logicalAnd   (AND)
  → notExpression  (NOT … NOT)           ← new
  → isNull       (IS [NOT] NULL)
  → equality
  → comparison
  → term → factor → unary (-, +, ~ only) → …
```

SQL-standard mapping (`<boolean factor> ::= [NOT] <boolean test>`,
`<boolean test> ::= <boolean primary> [ IS [NOT] (TRUE|FALSE|UNKNOWN) ]`)
places `NOT` exactly there.

### Why the planner is unaffected

After the fix, `parse('not x in (1,2,3)')` produces
`UnaryExpr { operator: 'NOT', expr: InExpr { ... } }` — the *same* AST
shape that `parse('x not in (1,2,3)')` produces today via the post-fix
path at `comparison()` (`parser.ts:1259-1307`). Every planner consumer
of `UnaryOpNode{NOT}` over a predicate already handles this shape:

- `predicate-normalizer.ts` `pushNotDown()` — recognises NOT over
  `BinaryOpNode`/`BetweenNode` and applies De Morgan / inversion / flag
  toggling; generic fallback wraps in `UnaryOpNode{NOT}` (same as input).
- `sat-checker.ts` — top-level `UnaryOpNode{NOT}` is conservatively
  marked `sawUnknown` (correct under-approximation).
- `fd-utils.ts` lines ~961-990 — `UnaryOpNode{NOT}` over a column
  reference records `IS NOT NULL` + numeric `col = 0`; over a predicate
  it falls through (sound, just no extra FDs).
- `rule-subquery-decorrelation.ts` — `UnaryOpNode{NOT}` over
  `ExistsNode` is the explicit `NOT EXISTS → anti-join` pattern.
- `assertion-classifier.ts` `negateAst` — generic NOT-over-InExpr falls
  through to the wrap-in-NOT fallback (unchanged).

So the planner change is a **no-op by construction**. The implement
work still smoke-tests this — see "Validation" below.

### Stringifier defensive parens

`ast-stringify.ts:180-191` only parenthesises a `unary NOT(...)` body
when it is a `binary`. After the parser fix, the unparenthesised form
re-parses correctly — but make the emitter robust to any future
refactor by parenthesising NOT's body when it is anything other than a
primary. The new rule:

```
needsParensForNot(inner) ⇔ inner.type ∈ {
  'in', 'between', 'binary', 'unary' (IS [NOT] NULL or another NOT),
  'cast', 'collate', 'exists'
}
```

Primaries (`literal`, `identifier`, `column`, `function`, `parameter`,
`subquery`, `parens`, `case`) emit without extra parens — they are
already self-delimiting.

Place the helper next to the `unary` case in `expressionToString`. Do
not touch the `IS [NOT] NULL` arm.

### Test surface

Three deterministic sqllogic locks. Each must fail on `main` (after a
prior `git stash` of the parser fix) and pass with the fix applied.

1. `test/logic/02-filters.sqllogic` — five `select (NOT P)` lines from
   the matrix above. Pure parser-level coverage.
2. `test/logic/40.2-check-extras.sqllogic` — `check (not Color in
   (select Code from Block))` defined via direct `create table`. Proves
   the parser fix lands independently of the stringifier.
3. `test/logic/50-declarative-schema.sqllogic` — issue-#22 verbatim:
   `declare schema { table T (..., constraint NB check (Color not in
   (select Code from Block))); } apply schema; insert ...` Proves the
   stringify→re-parse round-trip is now semantically equivalent.

Exact SQL for each is in the "Tests to add" section of the source fix
ticket; copy verbatim.

## Risks & follow-ups

- **Adjacent stringifier dropouts.** This ticket adds the defensive
  helper at the unary case only. Sibling ticket
  `plan-ast-stringify-roundtrip-property-test` (already planned for
  issue #23) is the structural fix; do not pre-empt it here.
- **Property-style precedence matrix.** Sibling
  `plan-prefix-not-precedence-test-matrix` would generate the full
  `NOT × predicate` Cartesian product; not in scope.
- **Declarative-schema semantic equivalence harness.** Sibling
  `plan-declarative-schema-semantic-equivalence-harness` would assert
  that direct-DDL and declare/apply produce semantically identical
  schemas across the entire engine. Not in scope.
- The `logicalXorOr` → `logicalAnd` step uses `parseBinaryChain`; the
  new `notExpression()` is *not* a binary chain — it's a right-recursive
  prefix matcher. Don't try to express it through `parseBinaryChain`.
- The `LIKE … ESCAPE …` form, if/when added, would live inside
  `comparison()` — no interaction with this change.

## TODO

### Phase 1 — parser fix

- In `packages/quereus/src/parser/parser.ts`:
  - Add a new private method `notExpression()` placed between
    `logicalAnd()` and `isNull()` (above `isNull`, below
    `logicalAnd`).
  - `notExpression()` matches zero or more leading `TokenType.NOT`
    tokens, then delegates to `this.isNull()`. Each `NOT` wraps the
    result in a `UnaryExpr { type: 'unary', operator: 'NOT', expr,
    loc }`. Stacked NOTs (`not not p`) fall out naturally via
    iteration or right-recursion — either is fine, pick recursion to
    mirror `unary()`'s shape.
  - Update `logicalAnd()` to descend into `notExpression()` instead of
    `isNull()`.
  - In `unary()` (line 1464), remove `TokenType.NOT` from the `match()`
    call. Keep `MINUS`, `PLUS`, `TILDE`. Update the method's docstring.
  - Sanity-check the post-fix `comparison()` `NOT IN` / `NOT BETWEEN`
    / `NOT LIKE` paths (lines 1257-1348) — they consume `NOT` only
    when it follows an operand inside the comparison loop and so are
    not reachable from prefix position. No change needed, but assert
    by reading.
  - Watch for any other matcher that consumes `NOT` for a non-postfix
    purpose — `grep` the file for `TokenType.NOT` and confirm only:
    (a) the new `notExpression()` use, (b) the `IS [NOT] NULL` path
    in `isNull()`, (c) the post-fix `comparison()` paths, (d) the
    `NOT IN` / `NOT BETWEEN` / `NOT LIKE` paths above.

### Phase 2 — stringifier defensive parens

- In `packages/quereus/src/emit/ast-stringify.ts`:
  - Add a top-level helper (next to `needsParens`) named
    `notBodyNeedsParens(expr: AST.Expression): boolean`. Returns true
    for `'in' | 'between' | 'binary' | 'cast' | 'collate' | 'exists'`,
    and for `'unary'` where the inner operator is `'NOT'` or
    `'IS NULL'` or `'IS NOT NULL'`. Returns false for everything else.
  - In the `'unary'` case (line 180), replace the
    `expr.expr.type === 'binary'` check used for the `NOT` arm with a
    call to `notBodyNeedsParens(expr.expr)`. Leave the arithmetic-
    unary fallthrough (`return ${op.toLowerCase()}${exprStr}`)
    untouched.
  - Leave `IS NULL` / `IS NOT NULL` arms alone — they already render
    `${exprStr} ${op}`, which is unambiguous.

### Phase 3 — regression tests

- `packages/quereus/test/logic/02-filters.sqllogic` (or a new
  `03.8-not-precedence.sqllogic` — pick whichever matches the file's
  current grouping; if `02-filters` already covers IN/BETWEEN/LIKE/
  IS NULL it's the natural host):
  ```
  select (not 5 in (1,2,3)) as a;        → true
  select (not 5 between 1 and 3) as b;   → true
  select (not 'a' like 'b%') as c;       → true
  select (not null is null) as d;        → false
  select (not 0 = 5) as e;               → true
  ```
- `packages/quereus/test/logic/40.2-check-extras.sqllogic` — direct-
  DDL prefix-NOT CHECK:
  ```
  create table Block (Code text primary key) using memory;
  insert into Block values ('r'), ('y');
  create table T (Id int, Color text, primary key (Id),
                  constraint NB check (not Color in (select Code from Block))) using memory;
  insert into T (Id, Color) values (1, 'g');   -- succeeds
  insert into T (Id, Color) values (2, 'r');   -- error: CHECK constraint failed: NB
  drop table T;
  drop table Block;
  ```
- `packages/quereus/test/logic/50-declarative-schema.sqllogic` —
  issue-#22 verbatim:
  ```
  declare schema main
  {
      table Block (Code text primary key);
      table TIn (
          Id int, Color text,
          primary key (Id),
          constraint NoBlocked check (Color not in (select Code from Block))
      );
  }
  apply schema main;
  insert into Block (Code) values ('r');
  insert into Block (Code) values ('y');
  insert into TIn (Id, Color) values (1, 'g');   -- succeeds
  select Color from TIn;
  → [{"Color":"g"}]
  insert into TIn (Id, Color) values (2, 'r');   -- error: CHECK constraint failed: NoBlocked
  drop table TIn;
  drop table Block;
  ```

### Phase 4 — validation

- `yarn workspace @quereus/quereus run test 2>&1 | tee /tmp/quereus-test.log` — full
  test suite (memory-backed vtab). Must be green.
- `yarn workspace @quereus/quereus run lint 2>&1 | tee /tmp/quereus-lint.log` — must
  be clean. (Use single-quoted globs on Windows.)
- `yarn build 2>&1 | tee /tmp/quereus-build.log` — full monorepo build,
  catches any cross-package type breakage.
- **Planner smoke-test** (handle as inline analysis, no extra tests):
  pick one query that exercises each planner path that touches
  `UnaryOpNode{NOT}` over a predicate, and confirm `explain` output is
  unchanged between the post-fix form (`x not in (...)`) and the
  prefix form (`not x in (...)`):
  - `select * from t where not c in (1,2,3)` vs.
    `select * from t where c not in (1,2,3)` — `predicate-normalizer`,
    `sat-checker`, `fd-utils`.
  - `select * from t where not exists (select 1 from u where u.x = t.x)`
    vs. `... where not exists (...)` (already prefix; just confirm
    `rule-subquery-decorrelation` still produces an anti-join).
  Easy way: capture `pragma plan = explain; select ...` output for
  each pair and `diff` in-session — they should be byte-equivalent
  (or differ only in operator-string positions of NOT, which is fine
  as long as the operator tree shape matches).
- Do **not** run `yarn test:store` — it's slow and not relevant to
  this change. Note the deferral here, let release/CI handle it.
