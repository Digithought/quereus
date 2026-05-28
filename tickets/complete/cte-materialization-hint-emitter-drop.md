---
description: Fixed the silent round-trip drop of `CommonTableExpr.materializationHint` — `withClauseToString` now emits `materialized` / `not materialized` after `as` so `parse(astToString(ast))` preserves the hint. Widened `cteSelectArb` in the AST property suite to sample the hint, added targeted structural unit cases, and documented the emitter's round-trip-fidelity policy. Review extended the structural test to cover the recursive-CTE and column-list cross-products the implementer left as gaps.
files:
  - packages/quereus/src/emit/ast-stringify.ts
  - packages/quereus/test/emit-roundtrip-property.spec.ts
  - packages/quereus/test/emit-roundtrip.spec.ts
---

## What landed

The bug: the parser populated `CommonTableExpr.materializationHint` from
`[NOT] MATERIALIZED` (parser.ts:301-316), but `withClauseToString` emitted
`as (${query})` with no keyword, so `with x as materialized (select 1)`
re-emitted as `with x as (select 1)` — a silent hint drop.

- **`emit/ast-stringify.ts`** — `withClauseToString` inserts the keyword
  between `as` and the opening paren via a new `materializationHintToKeyword`
  helper (mirrors `compoundOpToKeyword`). Exhaustive `switch` over the union
  (`'materialized' | 'not_materialized' | undefined`) so a future hint value
  fails the type-check rather than dropping silently. Added a "Round-trip
  policy" paragraph to the file header.
- **`test/emit-roundtrip-property.spec.ts`** — `materializationHintArb`
  threaded into `cteSelectArb`; the hint is set only when defined.
- **`test/emit-roundtrip.spec.ts`** — structural test asserting the hint
  survives `parse(astToString(ast))`, plus idempotence smoke tests.

## Review findings

Reviewed the implement diff (24b0e485) with fresh eyes against the SPP / DRY /
type-safety / coverage / docs angles. The implementation is correct and the
emitter is reached uniformly from all CTE-bearing statements.

**What was checked:**

- **Correctness & symmetry.** Confirmed parser (`commonTableExpression`,
  parser.ts:301-307) and emitter are inverse: keyword position (after `as`,
  after any column list), the two-token `not materialized` form (space, not
  `notmaterialized`), and `undefined → no keyword`. Verified against the
  structural test, which asserts the hint survives the *first* round-trip
  against the original input.
- **Coverage of statement types.** `withClauseToString` is the sole WITH
  emitter and is called from `selectToString`, `insertToString`,
  `updateToString`, and `deleteToString` — the hint now emits everywhere a
  CTE can appear, not just SELECT. Recursive CTEs route through the same map.
- **DRY / modularity.** `materializationHintToKeyword` follows the existing
  `compoundOpToKeyword` pattern; no duplication.
- **Type safety.** The `switch` is exhaustive over the union with no
  `default`, so adding a hint variant is a compile error. Build clean.
- **Property-suite regression guard.** Confirmed the comparator treats
  generator-omitted ≡ reparsed-`undefined` (both normalize to `undefined`),
  and that a hypothetical re-introduced drop (generator sets `'materialized'`,
  emitter omits) would fail the property test — so the widened `cteSelectArb`
  genuinely guards the regression for the non-recursive / no-column-list case.
- **Docs.** `docs/sql.md` already documents the hint semantics (line 1574),
  the not-yet-enforced note (1753-1758), and the grammar
  (`"as" [ "materialized" | "not" "materialized" ]`, line 3490). The bug was
  emitter-only; the language docs were already correct, so no SQL-doc change
  was warranted. The emitter's round-trip-fidelity policy is documented in the
  `ast-stringify.ts` header — the spot an emitter editor reads.

**Minor — fixed inline:**

- The implementer's two new `roundTripStmt` cases (`WITH MATERIALIZED hint`,
  `WITH NOT MATERIALIZED hint`) only prove **idempotence** (`str2 === str1`) —
  a dropped hint re-emits identically and still passes them, so they do not
  actually guard the regression. Only the structural test does. The
  implementer explicitly flagged **recursive-CTE + hint** and
  **column-list + hint** as untested cross-products. I extended the structural
  assertion loop in `emit-roundtrip.spec.ts` to cover both, for `materialized`
  and `not_materialized`:
  - `with x (a) as [not] materialized (select 1) ...`
  - `with recursive r(n) as [not] materialized (select 1 union all ...) ...`
  These assert `reparsed.withClause.ctes[0].materializationHint` against the
  original — closing both gaps where it matters. Added a comment explaining
  why idempotent round-trips are insufficient for this class of regression.

**Major — none.** No new tickets filed.

**Out of scope (unchanged from implement, correctly deferred):** the property
generator still pins `recursive: false` and omits CTE column lists (arity
coupling to VALUES bodies) — fuzzing those cross-products would require
restructuring the arbitrary; the new structural unit cases cover the same
ground deterministically. Planner *semantics* of `[not] materialized` on a
recursive CTE (`buildRecursiveCTE` defaults to `'materialized'`, with.ts:204)
remain a separate concern — this work is purely syntactic round-trip fidelity.

## Validation

- `yarn workspace @quereus/quereus run build` (tsc) — clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- `node test-runner.mjs --grep "round-trip"` — 200 passing (includes the
  widened structural case and the property suite at numRuns: 100).
- Full quereus suite (`node test-runner.mjs`) — 3683 passing, 9 pending,
  0 failing, exit 0.

`yarn test:store` not run — the change is confined to the pure
parser↔stringifier path and touches no vtab/store code.
