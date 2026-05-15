---
description: Extend the guard-clause vocabulary so partial UNIQUE / CHECK-implication recognition accepts OR-form predicates, IN-lists, and `NOT col` on the producer side, and `predicateImpliesGuard` discharges them on the consumer side. Today everything outside `=`, `==`, `IS NULL`, `IS NOT NULL` at the conjunct level is dropped on the floor.
prereq:
files:
  packages/quereus/src/planner/nodes/plan-node.ts
  packages/quereus/src/planner/util/fd-utils.ts
  packages/quereus/src/planner/analysis/partial-unique-extraction.ts
  packages/quereus/src/planner/analysis/check-extraction.ts
  packages/quereus/src/planner/analysis/predicate-shape.ts
  packages/quereus/src/planner/nodes/filter.ts
  packages/quereus/src/planner/nodes/subquery.ts
  packages/quereus/test/optimizer/conditional-fds.spec.ts
  docs/optimizer.md
---

## Approach chosen

Option 1 from the plan ticket — **extend `GuardClause`** with one new
variant (`or-of`) and pre-normalize `IN (...)` and `NOT col` at recognition
time into clauses the existing vocabulary already covers. Producer and
consumer apply the same normalization so they stay in lockstep.

Rejected: a full CNF/DNF pass on partial predicates. It pulls in too many
edge cases (function calls, casts, parenthesization) for the use cases the
ticket actually calls out. The narrow normalization below covers all of
them with a few syntactic rewrites.

## Guard-clause vocabulary changes

```ts
export type GuardClause =
  | { kind: 'eq-literal'; column: number; value: SqlValue }
  | { kind: 'eq-column';  left: number; right: number }
  | { kind: 'is-null';    column: number; negated: boolean }
  | { kind: 'or-of';      clauses: readonly GuardClause[] };   // NEW
```

`or-of` is a flat disjunction — nested `or-of` clauses are inlined at
construction time. Sub-clauses must come from the other three (no
`or-of` directly inside `or-of`); recognizers enforce this by flattening.

### Normalization rules

Applied symmetrically by `recognizeClause` (producer) and
`buildPredicateFacts` (consumer):

| Source shape                       | Recognized as                                        |
|------------------------------------|------------------------------------------------------|
| `col IN (lit, lit, …)`             | `or-of [eq-literal{col, lit_i}]`                     |
| `col IN (singleton-lit)`           | `eq-literal{col, lit}` (degenerate OR collapses)     |
| `NOT col`                          | `eq-literal{col, value: 0}` (integer 0)              |
| `a OR b`                           | `or-of [recognize(a), recognize(b)]`                 |

Soundness notes:

- `NOT col` excludes both `col IS NULL` rows and `col != 0` rows. The
  guard `col = 0` is exactly the rows the partial-index predicate
  includes — `col = 0` ⇒ `col IS NOT NULL`. The integer literal `0` is
  the value SQLite produces for the boolean `FALSE`.
- `IN` recognition requires every value expression to be a literal (uses
  `literalValue` — no parameters, no function calls). Otherwise the IN
  bails out and the clause is unrecognized (whole partial predicate
  rejected, same conservative rule as today).
- `OR` recognition flattens chains: `a OR b OR c` → `or-of [a, b, c]`.

## Discharge rules for `or-of`

Inside `clauseEntailed` (`fd-utils.ts`):

```
case 'or-of': {
  // (a) Any sub-clause directly entailed by facts ⇒ OR entailed.
  for (const sub of clause.clauses) {
    if (clauseEntailed(sub, facts, ecs, bindings, isColumnNonNullable)) return true;
  }
  // (b) Pure-IN specialization: every sub-clause is eq-literal on the same column.
  //     Entailed when the filter pins that column to a subset of the OR-set.
  return inListEntailed(clause, facts, ecs, bindings);
}
```

`inListEntailed`:

1. Check every sub-clause is `eq-literal` and they all reference the
   same column `c`. Otherwise bail.
2. Collect the OR-set `T = { value of each sub-clause }`.
3. The filter pins `c` to a subset of `T` when **either**:
   - `facts.literalEqs.get(c)` ∈ `T`, **or**
   - `facts.inListEqs.get(c)` is defined and `⊆ T`.
4. Also try every EC-peer of `c` and every column sharing a constant
   binding with `c` (same logic as `eq-literal` discharge).

### New fact captured by `buildPredicateFacts`

```ts
interface PredicateFacts {
  …existing…
  /** column index → set of literal values from `col IN (lit, lit, …)`. */
  readonly inListEqs: ReadonlyMap<number, ReadonlySet<SqlValue>>;
}
```

Populated when the filter predicate's plan-node tree contains an
`InNode` (`packages/quereus/src/planner/nodes/subquery.ts:85`) with all
value-side `LiteralNode`s and a `ColumnReferenceNode` on the
`condition`. Subquery-form IN is ignored (same conservative rule as
`check-extraction.ts:144-159`).

`UnaryOpNode(operator='NOT', operand=ColumnReferenceNode)` is folded
into `literalEqs(col, 0)` so a query `WHERE NOT archived` discharges a
partial whose guard is `eq-literal{archived, 0}` (rewritten from `NOT
archived` on the producer side).

## Producer-side recognizer (`partial-unique-extraction.ts`)

`recognizeClause` learns three new top-level shapes:

```ts
function recognizeClause(expr, columnIndexMap): GuardClause | undefined {
  if (expr.type === 'unary') {
    const u = expr as AST.UnaryExpr;
    if (u.operator === 'IS NULL' || u.operator === 'IS NOT NULL') { …existing… }
    if (u.operator === 'NOT') {
      const col = columnIndexFromExpr(u.expr, columnIndexMap);
      if (col === undefined) return undefined;
      return { kind: 'eq-literal', column: col, value: 0 };
    }
    return undefined;
  }
  if (expr.type === 'in')      return recognizeIn(expr as AST.InExpr, columnIndexMap);
  if (expr.type === 'binary'   && (expr as AST.BinaryExpr).operator === 'OR')
                               return recognizeOr(expr as AST.BinaryExpr, columnIndexMap);
  // … existing eq / is-null path …
}
```

- `recognizeIn` returns `undefined` for IN-with-subquery or any non-literal
  value; returns `eq-literal` when the list collapses to a single value;
  otherwise builds an `or-of` of `eq-literal`s.
- `recognizeOr` flattens via the existing `flattenDisjunction` helper
  (move it out of `check-extraction.ts` into `predicate-shape.ts` so both
  modules share it), recognizes each disjunct via `recognizeClause`
  recursively, returns `undefined` if any disjunct fails. Single-disjunct
  collapse mirrors the IN case.

## Consumer-side housekeeping (`fd-utils.ts`)

Update for the new variant:

- `guardClauseEquals`: add `or-of` case with order-insensitive sub-clause
  comparison (reuse the `used`-array technique already used for top-level
  clause matching in `guardsEqual`).
- `projectGuard` / `shiftGuard`: add `or-of` recursion. If any nested
  `eq-literal`/`eq-column`/`is-null` projects away (column not in
  mapping), the whole `or-of` projects away — same conservative rule as
  the rest of `projectGuard`.
- `clauseEntailed`: add the `or-of` case sketched above.
- `buildPredicateFacts`: extend to populate `inListEqs` from `InNode`
  and `literalEqs(col, 0)` from `UnaryOpNode('NOT', col)`.

## CHECK-extraction (`check-extraction.ts`)

In scope:
- `flattenDisjunction` lifts to `predicate-shape.ts` so both files share
  it.
- `recognizeNegatedGuard` stays as-is. The implication form
  (`¬g_1 OR … OR body`) is orthogonal to the new clause shapes — the
  existing negated-equality / negated-is-null recognition covers the
  guards CHECK constraints actually carry. Allowing `or-of`/`in-list`
  *inside* a CHECK implication body is filed as backlog (see below).

Out of scope:
- Recognizing CHECK-form `(¬g_1) OR … OR (body)` where any `¬g_i` is an
  `IN`-list or `NOT col`. Today's recognizer rejects those disjuncts
  and bails on the whole CHECK — that's still the conservative behavior
  after this change. Filed as `fd-check-implication-or-in-shapes`
  backlog.

## Tests (key bullets)

Add to `packages/quereus/test/optimizer/conditional-fds.spec.ts`:

- Partial UNIQUE `WHERE status IN ('active', 'pending')`:
  - filter `WHERE status IN ('active', 'pending')` → singleton FD lands.
  - filter `WHERE status = 'active'` → singleton FD lands.
  - filter `WHERE status = 'inactive'` → no singleton FD.
  - filter `WHERE status IN ('active', 'expired')` → no singleton FD
    (filter's set ⊄ partial's set).
- Partial UNIQUE `WHERE deleted_at IS NULL OR status = 'archived'`:
  - filter `WHERE deleted_at IS NULL` → singleton FD lands.
  - filter `WHERE status = 'archived'` → singleton FD lands.
  - filter `WHERE id = 1` (matches neither disjunct) → no singleton FD.
- Partial UNIQUE `WHERE NOT archived` on declared-NOT-NULL int col:
  - filter `WHERE archived = 0` → singleton FD lands.
  - filter `WHERE NOT archived` → singleton FD lands.
  - filter `WHERE archived = 1` → no singleton FD.
- Recognizer edge cases (no surrounding FD test needed):
  - `WHERE col IN (?)` (parameter, not literal) → recognizer returns
    `undefined`, no FD emitted.
  - `WHERE col IN ('a')` (singleton list) → collapses to `eq-literal`.
  - `WHERE a OR b OR c` (3-way disjunct) → produces flat `or-of` of 3
    sub-clauses.
- `guardClauseEquals` symmetry: two `or-of` clauses with the same
  sub-clauses in different orders compare equal; `or-of [A,B]` vs
  `or-of [A,C]` compare unequal.
- `projectGuard` drops an `or-of` when any nested column is unmapped
  (same conservative rule as the rest of projection).

Expected outcomes for the end-to-end UC tests: the `PhysicalProperties`
of the `FilterNode` includes a `singletonFd` (∅ → all_cols) for the
positive cases and does not for the negative cases — mirrors the test
style in the conditional-fds spec for partial UNIQUE.

## Sqllogic coverage

Append a section to `packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic`
exercising the IN and NOT shapes end-to-end (one positive INSERT-conflict
case per shape, one negative case). Mirrors the layout the
`fd-guard-isnotnull-relaxes-notnull-gate` ticket added at sections 7g/7h.

## Docs

Update `docs/optimizer.md`:
- "Partial UNIQUE indexes…" section: expand the recognized-shape table to
  include `IN (lit, lit, …)`, `NOT col`, and top-level OR.
- "Guard clause vocabulary" callout: add the `or-of` variant and the
  pre-normalization rules. Keep the soundness note about the `NOT col` →
  `col = 0` rewrite (mention three-valued logic explicitly).

## Out of scope (backlog)

- IN / NOT / OR shapes inside CHECK implication disjuncts
  (`recognizeNegatedGuard`). File as `fd-check-implication-or-in-shapes`
  if a use case shows up.
- Standalone column-as-predicate (`WHERE col` meaning `col != 0`).
- Function-call or cast-wrapped column references in IN / NOT shapes.
- General CNF/DNF rewriting beyond the four bullets above.

## TODO

Phase 1 — vocabulary + projection plumbing
- Add `or-of` variant to `GuardClause` in `plan-node.ts`.
- Extend `guardClauseEquals`, `projectGuard`, `shiftGuard` in `fd-utils.ts`
  to recurse into `or-of`. Reject projections that drop any sub-column.
- Move `flattenDisjunction` from `check-extraction.ts` to
  `predicate-shape.ts` (rename retained: still local-shape helper).

Phase 2 — producer
- Extend `recognizeClause` in `partial-unique-extraction.ts` with the
  three new shapes (`NOT col`, `IN`, top-level `OR`). Add `recognizeIn`
  and `recognizeOr` helpers; flatten nested OR; collapse singleton IN /
  OR to the underlying clause.

Phase 3 — consumer
- Extend `PredicateFacts` with `inListEqs`. Populate from `InNode`
  (literal-only value list) in `buildPredicateFacts`.
- Recognize `UnaryOpNode(NOT, ColumnReferenceNode)` as
  `literalEqs(col, 0)`.
- Add the `or-of` case in `clauseEntailed`: any sub-clause entailed → OR
  entailed; plus the pure-IN specialization using `inListEqs`/`literalEqs`
  subset checking, walked through ECs and bindings.

Phase 4 — tests + docs
- Spec coverage in `conditional-fds.spec.ts` (bullets above).
- Sqllogic coverage in `10.5.1-partial-indexes.sqllogic`.
- Docs update in `docs/optimizer.md`.

Validation (foreground, streamed):
- `yarn workspace @quereus/quereus run lint`
- `yarn workspace @quereus/quereus run test --grep "conditional-fds|Partial UNIQUE|10\\.5\\.1"`
- `yarn test`

Reviewer probes:
- `WHERE col IN (NULL, 'a')` — does the recognizer accept the literal
  NULL, and does discharge cope? Sound to accept (NULL is a literal
  `SqlValue`), but worth a spec case to pin the behavior.
- Nullable column under `WHERE NOT col` partial: the FD's NOT-NULL gate
  (the `nonNullByPredicate` set built from `is-null negated:true`
  clauses) does not see `NOT col` as "col IS NOT NULL". The `NOT col`
  → `eq-literal{col, 0}` rewrite *does* exclude NULL rows semantically,
  but the gate is syntactic. Decide whether to (a) teach the gate
  about the new shape, (b) require the partial predicate to also
  carry `col IS NOT NULL` explicitly, or (c) reject `NOT col` shapes
  on nominally-nullable UC columns and document the limitation. The
  implement pass should pick (c) — simplest, sound, matches today's
  gate behavior — and file a follow-up for (a) if needed.
