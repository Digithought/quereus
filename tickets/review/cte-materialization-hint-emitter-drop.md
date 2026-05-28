---
description: Fixed the silent round-trip drop of `CommonTableExpr.materializationHint`. `withClauseToString` now emits `materialized` / `not materialized` after `as`, so `parse(astToString(ast))` preserves the hint. Widened `cteSelectArb` in the AST property suite to sample the hint, added targeted unit cases, and documented the emitter's round-trip-fidelity policy in the `ast-stringify.ts` header.
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

Three changes, shape 1 from the ticket ("emit the hint"):

- **`emit/ast-stringify.ts`** — `withClauseToString` now inserts the
  keyword between `as` and the opening paren via a new
  `materializationHintToKeyword` helper (mirrors the existing
  `compoundOpToKeyword` pattern). Maps `'materialized' → 'materialized'`,
  `'not_materialized' → 'not materialized'`, `undefined → undefined`
  (no keyword). The `switch` is exhaustive over the union so a future
  hint value fails the type-check rather than silently dropping.
- **`test/emit-roundtrip-property.spec.ts`** — added `materializationHintArb`
  (`oneof: undefined | 'materialized' | 'not_materialized'`) and threaded
  it into `cteSelectArb`; the hint is set on the CTE only when defined
  (matches how a generated AST omits the key vs. the reparser's
  present-but-undefined — the comparator treats both as undefined). Updated
  the stale comment that claimed the hint "isn't emitted by today's
  stringifier."
- **`test/emit-roundtrip.spec.ts`** — three targeted cases under the SELECT
  block: `WITH MATERIALIZED hint`, `WITH NOT MATERIALIZED hint` (string
  round-trips), and `preserves the materialization hint structurally` (parses
  three SQLs and asserts the reparsed `materializationHint` equals
  `'materialized'` / `'not_materialized'` / `undefined`).
- **Policy doc** — added a "Round-trip policy" paragraph to the
  `ast-stringify.ts` file header stating the emitter is round-trip-faithful
  by default: every semantically meaningful field must survive
  `parse(astToString(ast))`; permitted drops are non-semantic metadata
  (`loc`, `comments`, conditional `lexeme`) and documented parser-default
  equivalences, each mirrored by an `emit-roundtrip-comparator.ts` entry.
  This is the ticket's "document the policy" deliverable.

## Validation

- `yarn workspace @quereus/quereus run build` (tsc) — clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- Targeted: `mocha emit-roundtrip.spec.ts emit-roundtrip-property.spec.ts`
  — 156 passing (includes the 3 new unit cases + the widened
  `CommonTableExpr.query body round-trips structurally` property at
  numRuns: 100).
- Full quereus suite (`yarn workspace @quereus/quereus run test`) — 3683
  passing, 9 pending, 0 failing.
- Manual emitter spot-check confirmed all four shapes emit the keyword in
  the right position: bare materialized, not materialized, **column-list +
  hint** (`with x (a) as materialized (...)`), and **recursive + hint**
  (`with recursive r (n) as materialized (...)`).

`yarn test:store` not run — the change is confined to the pure
parser↔stringifier path and touches no vtab/store code.

## Acceptance — disposition

- ✅ CTE with `materialized` / `not materialized` round-trips structurally
  (parsed `materializationHint` survives `parse(astToString(ast))`).
- ✅ `cteSelectArb` widened to sample the hint.
- ✅ Targeted unit case(s) in `emit-roundtrip.spec.ts` exercising both hint
  values (plus the `undefined` case).
- ✅ Policy documented (in the emitter header — the spot an emitter editor
  will actually read).

## Use cases for the reviewer to probe

- `with x as materialized (select 1) select * from x` — the canonical
  symptom from the ticket; must re-emit verbatim.
- `with x as not materialized (select 1) select * from x` — the
  two-keyword form; confirm the space (`not materialized`, not
  `notmaterialized` or `not_materialized`).
- `with x (a) as materialized (select 1) select * from x` — keyword
  ordering relative to the column list (column list before `as`, hint
  after). Emits correctly but is **not** in the automated suite (see gaps).
- `with recursive r(n) as materialized (...) select ...` — recursive CTEs
  route through the same `withClauseToString` map, so the hint now emits
  there too. Emits correctly but is **not** explicitly asserted (see gaps).

## Known gaps / floor, not ceiling

- **Recursive-CTE + hint is covered by the emitter path but not by an
  explicit test.** `withClauseToString` emits all CTEs uniformly, so the
  recursive case works (verified manually above), but neither the property
  suite (`cteSelectArb` pins `recursive: false`) nor the new unit cases
  assert it. A reviewer wanting belt-and-suspenders could add one
  `roundTripStmt('with recursive r(n) as materialized (...) ...')` line.
- **Column-list + hint combination is unexercised by the property suite.**
  `cteSelectArb` omits CTE column lists (arity-coupling to VALUES bodies,
  same reason as `createViewArb`), so the column-list × hint cross-product
  is only manually spot-checked, not fuzzed.
- **The property generator sets the hint only when defined**, relying on
  the comparator's `undefined ≡ missing` handling rather than mirroring the
  parser's "always-present, possibly-undefined" representation. This is
  consistent with how the suite handles other optional fields, but worth a
  glance to confirm it doesn't mask a future regression where the emitter
  emits a stray keyword for the undefined case (the explicit `undefined`
  unit assertion in `emit-roundtrip.spec.ts` guards this).
- **Semantics of `[not] materialized` on a recursive CTE** were not
  re-examined — this ticket is purely about syntactic round-trip fidelity.
  `buildRecursiveCTE` already defaults recursive CTEs to `'materialized'`
  (with.ts:204), so a `not_materialized` hint on a recursive CTE now
  survives re-emit; whether the planner honors it is a separate concern
  outside this ticket's scope.
