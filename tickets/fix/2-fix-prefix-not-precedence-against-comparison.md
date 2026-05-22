description: Prefix `not` binds tighter than IN / BETWEEN / LIKE / IS NULL / comparison in the Quereus parser, so `not x in (subquery)` mis-parses as `(not x) in (subquery)`. Stringifier-driven round-trip in `declare schema` / `apply schema` rewrites the user's `x not in (subquery)` into the broken form, which is the path that surfaced the bug in CHECK constraints (issue #22).
prereq:
files:
  packages/quereus/src/parser/parser.ts
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/src/runtime/emit/schema-declarative.ts
  packages/quereus/src/schema/schema-differ.ts
  packages/quereus/test/logic/02-filters.sqllogic
  packages/quereus/test/logic/40-constraints.sqllogic
  packages/quereus/test/logic/40.2-check-extras.sqllogic
  packages/quereus/test/logic/50-declarative-schema.sqllogic
  packages/quereus/test/logic/95-assertions.sqllogic
----
## Issue

GitHub issue [#22](https://github.com/gotchoices/quereus/issues/22): a CHECK
constraint of the form `check (X not in (subquery))` rejects every row
after `declare schema` / `apply schema`. Confirmed on 2.9.0 and 3.1.1.

The reporter's hypothesis — "early de-sugaring of `not in` into `not (in)`,
inner `in (subquery)` yields NULL, outer `not` produces NULL" — is wrong.
The actual root cause is a parser precedence bug that is independent of
CHECK; CHECK is just the path that lit it up.

## Scope (this is broader than CHECK)

The bug is in the parser. Every prefix-`not` placed in front of a
comparison/predicate is wrong, in any context (WHERE, view bodies, partial
index `where`, assertion bodies, optimizer inputs derived from these
predicates, RETURNING expressions). Concretely, against a real evaluator
the parser produces these results today:

| expression                       | quereus | sql standard / sqlite |
|----------------------------------|---------|-----------------------|
| `not 5 in (1,2,3)`               | false   | true                  |
| `not 5 between 1 and 3`          | false   | true                  |
| `not 'a' like 'b%'`              | false   | true                  |
| `not null is null`               | true    | false                 |
| `not 0 = 5`                      | false   | true                  |

Each row is the same bug: prefix `not` binds tighter than the predicate
that follows it. Per Quereus's priority order — sound TTM-style logic
first, SQL standard second, SQLite compatibility third — all three
authorities agree that `not P` should evaluate `P` as a complete
predicate, then negate. The current behaviour negates an operand first
and then runs the predicate on the negation, which is neither sound nor
standard nor SQLite-compatible.

The CHECK case surfaces because the stringifier emits the round-trip-
unsafe shape (`not Color in (...)` without parens), and the declarative-
schema path then re-parses its own output. Tables built via direct
`create table` from user-written `Color not in (subquery)` are unaffected
because the parser handles the post-fix `x not in (...)` form correctly
in `comparison()` (see Root cause below).

## Reproduction

Three layers, each tighter than the last.

1. **Parser-level (no DDL needed):**
   ```sql
   select ('g' not in (select 'r' union all select 'y')) as a,   -- true (post-fix path; correct)
          (not 'g' in (select 'r' union all select 'y')) as b,   -- false (prefix path; bug)
          (not ('g' in (select 'r' union all select 'y'))) as c; -- true (parens force grouping; correct)
   ```

2. **Direct `create table` — bug only on the prefix-NOT form:**
   ```sql
   create table Block (Code text primary key);
   insert into Block values ('r'), ('y');

   create table T1 (Id int, Color text, primary key (Id),
                    constraint NB1 check (Color not in (select Code from Block)));
   create table T2 (Id int, Color text, primary key (Id),
                    constraint NB2 check (not Color in (select Code from Block)));

   insert into T1 (Id, Color) values (1, 'g');   -- ok
   insert into T2 (Id, Color) values (1, 'g');   -- ConstraintError (bug)
   ```

3. **The issue-#22 case — `declare schema` rewrites `not in` into the broken form:**
   ```sql
   declare schema main
   {
       table Block (Code text primary key);
       table T (Id int, Color text, primary key (Id),
                constraint NB check (Color not in (select Code from Block)));
   }
   apply schema main;
   insert into Block (Code) values ('r'), ('y');
   insert into T (Id, Color) values (1, 'g');   -- ConstraintError (bug)
   ```

`diff schema main` emits `... check (not Color in (select Code from Block))`
— the user wrote the post-fix form, the stringifier emits the prefix
form, the parser then mis-parses it.

## Root cause

Two co-conspirators; the parser is the bug, the stringifier is the
amplifier.

**1. Parser precedence — `packages/quereus/src/parser/parser.ts`.**

The expression precedence chain is roughly
`expression → or → and → not? → equality → comparison → term → factor → unary → concatenation → …`,
but `unary()` (line 1464) handles `NOT` alongside arithmetic
`-` / `+` / `~`:

```ts
private unary(): AST.Expression {
    if (this.match(TokenType.MINUS, TokenType.PLUS, TokenType.TILDE, TokenType.NOT)) {
        const operatorToken = this.previous();
        const right = this.unary();
        return { type: 'unary', operator: operatorToken.lexeme, expr: right, ... };
    }
    return this.concatenation();
}
```

So `not 'g' in (subquery)` is consumed by `comparison()` like this:
- `comparison()` calls `term()` for the left operand
- `term()` descends to `factor()` → `unary()`, which matches `NOT`, recurses, consumes `'g'`, and returns `unary NOT('g')`
- Control returns to `comparison()`, which sees `IN` in its loop and builds `in { expr: unary NOT('g'), subquery }`

Result AST: `(NOT 'g') IN (subquery)`.

SQL standard precedence stack:

```
<boolean factor> ::= [NOT] <boolean test>
<boolean test>   ::= <boolean primary> [ IS [NOT] (TRUE|FALSE|UNKNOWN) ]
<boolean primary>::= <predicate> | ( <search condition> )
<predicate>      ::= <comparison> | <in> | <between> | <like> | <null> | <exists> | ...
```

`NOT` lives one level above predicates, *below* `AND`/`OR`. Quereus has
it at arithmetic-unary level, well below predicates. That is the bug.

The post-fix paths (`x not in (...)`, `x not between A and B`,
`x not like p`, `x is not null`) work because `comparison()` and
`isNullExpression()` handle them explicitly — they bypass the
mis-placement of prefix `NOT`.

**2. Stringifier — `packages/quereus/src/emit/ast-stringify.ts:180-191`.**

The `'unary'` case only parenthesizes its body when
`expr.expr.type === 'binary'`:

```ts
case 'unary': {
    const exprStr = expr.expr.type === 'binary'
        ? `(${expressionToString(expr.expr)})`
        : expressionToString(expr.expr);
    // ...
    } else if (expr.operator.toUpperCase() === 'NOT') {
        return `${expr.operator.toLowerCase()} ${exprStr}`;
    }
}
```

For a `unary NOT(InExpr)` AST — exactly what the parser produces from a
user-written `x not in (...)` via the `comparison()` post-fix path —
this emits `not x in (...)` with no parens. Combined with bug #1, the
re-parsed AST is `(NOT x) IN (...)`, semantically inverted.

The same drop occurs for `unary NOT(BetweenExpr)`,
`unary NOT(unary IS NULL)`, etc.

## Expected behaviour

`parse('not E P')` and `parse('not (E P)')` must yield ASTs that
evaluate identically for every predicate `P` (IN, BETWEEN, LIKE,
IS [NOT] NULL, `=`, `<>`, `<`, `<=`, `>`, `>=`). Equivalently, prefix
`NOT` must consume the entire predicate on its right, not just the
left operand.

Authority order (per `AGENTS.md`):
1. **TTM-style soundness**: `NOT P` is a propositional negation of a
   complete predicate; nothing else is logically meaningful.
2. **SQL standard**: `<boolean factor>` places `NOT` above predicates.
3. **SQLite compatibility**: both `not 'g' in (...)` and `'g' not in (...)`
   return the same boolean in SQLite.

All three point the same direction.

## Fix sketch (for the implement ticket — do not pre-implement here)

The minimal correct change is to remove `TokenType.NOT` from the
`unary()` matcher and introduce a `notExpression()` level *above*
`equality()` (and below `and()`):

```
or       → and → notExpression       → equality → comparison → ...
                  ^ new level: [NOT] equality
```

- `notExpression()` matches zero or more leading `NOT` tokens, then
  delegates to `equality()`. Each `NOT` wraps the result in a
  `UnaryExpr { operator: 'NOT', expr: ... }`. Stacked NOTs (`not not p`)
  fall out naturally.
- `unary()` keeps `MINUS`, `PLUS`, `TILDE` (arithmetic / bitwise) but no
  longer consumes `NOT`.
- The post-fix paths in `comparison()` (`x NOT IN ...`, `x NOT BETWEEN`,
  `x NOT LIKE`) and in `isNullExpression()` (`x IS NOT NULL`) stay
  as-is — they already produce the correct AST shape.

This is a precedence change, so verify nothing in the planner or
optimizer assumes the broken shape — grep for places that special-case
`UnaryOpNode` with operator `NOT` wrapping an `InNode`/`BetweenNode`
to make sure they continue to work when the wrap shifts up in the
tree. In particular check:

- `packages/quereus/src/planner/util/fd-utils.ts` (the `UnaryOpNode`
  branch at the fd-utils file documented in the architecture's
  functional-dependency framework).
- `packages/quereus/src/planner/analysis/sat-checker.ts` and
  `predicate-normalizer` rules (`packages/quereus/src/planner/rules/...`
  for predicate-contradiction).
- `packages/quereus/src/planner/analysis/assertion-classifier.ts`
  `negateAst` (already documents that `NOT` over `InExpr` falls through
  to the wrap-in-NOT fallback — that path stays correct after the fix,
  since the AST shape it sees is the same; only the parser's *source*
  of that shape changes).

The stringifier should additionally parenthesize the body of `unary NOT`
when it is anything other than a primary expression (`in`, `between`,
`like`, comparison-`binary`, `unary IS [NOT] NULL`, `cast`, parenthesised
binary, etc.). This is defensive: after the parser fix the unparenthesised
form re-parses correctly, but the change costs one branch and makes the
emitted SQL safe under any future parser refactor or third-party reader.
A small helper `needsParensForNot(expr)` keeps it in one place.

## Why our test suite missed this

Four compounding gaps. (1)–(3) are coverage; (4) is structural.

1. **Zero sqllogic tests for `check` + `not in (subquery)`** — grep across
   `test/logic/40-constraints.sqllogic`,
   `test/logic/40.2-check-extras.sqllogic`,
   `test/logic/29-constraint-edge-cases.sqllogic`,
   `test/logic/95-assertions.sqllogic`,
   `test/logic/50-declarative-schema.sqllogic` for `not in (select` returns
   zero hits. CHECK with a same-table or cross-table subquery is one of
   the headline features of the deferred-constraint engine
   (`docs/architecture.md` § Constraints) and yet has no negative-form
   coverage.

2. **No prefix-`not` precedence tests anywhere.** Tests exclusively use
   the post-fix forms `x not in (...)`, `x not between …`, `x not like …`,
   `x is not null`, which take the `comparison()` / `isNullExpression()`
   path and are correct. The prefix path through `unary()` is exercised
   nowhere.

3. **No `declare schema → apply schema` semantic-equivalence test.** The
   declarative-schema tests (`50-declarative-schema.sqllogic`) assert
   that DDL is *applied*, not that an applied CHECK / DEFAULT / partial-
   index `where` evaluates the same as the same expression in a direct
   `create table`. The schema differ's `generateMigrationDDL` is treated
   as cosmetic, but it is in fact a semantic boundary that re-runs every
   constraint through `parse → AST → stringify → parse`.

4. **No AST round-trip property test** — the structural gap. Sibling
   plan ticket `plan-ast-stringify-roundtrip-property-test` (already
   filed for issue #23) is the right venue for closing this class of
   bug by construction. That ticket would have caught the stringifier's
   parenthesisation drop. It would *not* have caught the parser
   precedence bug on its own — for that we need test layer (2). Both
   are needed.

The fix for this ticket lands the parser correction plus the targeted
sqllogic coverage below; the property-style precedence matrix is the
sibling plan ticket `plan-prefix-not-precedence-test-matrix`, and the
broader integration-level guarantee is
`plan-declarative-schema-semantic-equivalence-harness`.

## Tests to add for this fix

The first three are deterministic regression locks that fail on `main`
and pass after the fix. Each one is the human-readable witness for the
class of bug the corresponding plan ticket generalises.

1. **Targeted reproduction** in
   `packages/quereus/test/logic/50-declarative-schema.sqllogic` —
   the exact issue-#22 shape:

   ```sql
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
   insert into TIn (Id, Color) values (1, 'g');   -- must succeed
   select Color from TIn;
   → [{"Color":"g"}]
   insert into TIn (Id, Color) values (2, 'r');   -- must fail
   -- error: CHECK constraint failed: NoBlocked
   drop table TIn;
   drop table Block;
   ```

2. **Parser-level precedence coverage** in
   `packages/quereus/test/logic/02-filters.sqllogic` (or a new
   `test/logic/03.8-not-precedence.sqllogic`) — the five expressions
   from the Scope table, each in a `select` that asserts the boolean
   result:

   ```sql
   select (not 5 in (1,2,3))           as a;   → [{"a":true}]
   select (not 5 between 1 and 3)      as b;   → [{"b":true}]
   select (not 'a' like 'b%')          as c;   → [{"c":true}]
   select (not null is null)           as d;   → [{"d":false}]
   select (not 0 = 5)                  as e;   → [{"e":true}]
   ```

3. **Direct-DDL prefix-NOT CHECK** in
   `packages/quereus/test/logic/40.2-check-extras.sqllogic` — the
   "T2" half of the reproduction above (no declarative schema involved),
   to prove the parser fix lands independently of the stringifier:

   ```sql
   create table Block (Code text primary key) using memory;
   insert into Block values ('r'), ('y');
   create table T (Id int, Color text, primary key (Id),
                   constraint NB check (not Color in (select Code from Block))) using memory;
   insert into T (Id, Color) values (1, 'g');   -- must succeed
   insert into T (Id, Color) values (2, 'r');   -- must fail
   -- error: CHECK constraint failed: NB
   drop table T;
   drop table Block;
   ```

The sqllogic file `40-constraints.sqllogic` (which holds the `check on
delete` matrix) is also a sensible host for (3) — pick whichever fits
the existing organisation.

## Adjacent risk

Surveyed during investigation; track as separate follow-ups unless the
implementer notices an easy combined fix.

- **Optimizer FD propagation** for `unary NOT` wrapping `between` /
  `in` / `is null` (see `fd-utils.ts` — the comment block at the
  `UnaryOpNode` branch). After the parser fix the AST that reaches
  fd-utils is identical to what it sees today for the post-fix forms,
  so this should be a no-op — but worth a smoke test that
  `predicate-contradiction` and the assertion-as-premise pipeline still
  produce the same physical plans for `select … where not c in (1,2)`
  and `select … where c not in (1,2)`.
- **Stringifier defensive parens** for all `unary NOT(non-primary)`
  shapes, not only `binary`. Filed as part of the fix sketch above.
- **`create assertion ... check (not exists ...)` and the
  hoisting-to-premise path** — the input is parser-shaped, so the parser
  fix carries through; but a sqllogic test that an assertion written
  with prefix `not` survives the apply-schema round-trip is cheap
  insurance.
