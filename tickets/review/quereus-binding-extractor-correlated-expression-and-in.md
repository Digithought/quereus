---
description: Review the `correlated` flag added to `PredicateConstraint` and the rewritten cover guard in `computeCoveredKeysForConstraints`. Extends the parent correlated-binding fix to cover singleton correlated `IN` (`p.id IN (outer.id)`) and any value side that references an outer table, via an orthogonal per-constraint boolean computed by a free-reference walk. NOTE a key honest finding: the wrapped-arithmetic equality shape from the ticket's "Gap 1" (`p.id = outer.id + 1`) is **never extracted** by `extractBinaryConstraint` (it stays residual), so it cannot reach the cover guard and was already safe. The genuine new fix is the singleton-`IN` case (Gap 2) plus the cast-wrapped column-ref case; the general-expression branch is correctly wired and future-proofed but currently unreachable through this code path.
prereq:
files:
  packages/quereus/src/planner/analysis/constraint-extractor.ts
  packages/quereus/test/planner/constraint-extractor.spec.ts
----

# Review: correlated-binding cover guard — `'expression'` (outer-ref) and singleton-IN

## What changed

`computeCoveredKeysForConstraints` previously skipped only `op === '=' && bindingKind === 'correlated'` when deciding whether a constraint covers a unique key. That guard missed two shapes the parent fix deferred. This change replaces the `bindingKind`-based check with an orthogonal `correlated` boolean computed at extraction time.

### Source changes (`constraint-extractor.ts`)

- **New field** `correlated?: boolean` on `PredicateConstraint` (interface, ~line 47). Documented as row-scope *escape*, orthogonal to `bindingKind` (binding *shape*). No new `bindingKind` enum members were added (per ticket's "Do NOT").
- **New helpers** (placed just before `combineParts`, ~line 285):
  - `collectColumnRefAttributeIds(node)` — iterative stack walk collecting `ColumnReferenceNode.attributeId`s from a scalar subtree, descending through `getChildren()` (so it reaches refs nested under casts/arithmetic/functions, subsuming the top-level-only `unwrapCast`).
  - `bindingReferencesOuterTable(valueExpr, tableInfo)` — true iff any collected attributeId is absent from `tableInfo.columnIndexMap`.
- **`extractBinaryConstraint`** (~line 359): in the non-literal value-side branch, after computing `bindingKind`, sets `result.correlated = bindingReferencesOuterTable(valueSide, tableInfo)`. The bare other-table column-ref case (`'correlated'`) and the same-table case (`'expression'`) now both get a consistent flag.
- **`extractInConstraint`** (~line 465): in the `!allLiteral` branch, sets `result.correlated = expr.values.some(v => bindingReferencesOuterTable(v, tableInfo))`. `bindingKind` stays `'mixed'` (unchanged, per ticket).
- **Cover guard** (`computeCoveredKeysForConstraints`, ~line 910): the loop now does `if (c.correlated) continue;` then unconditionally adds `=` and singleton-`IN` columns. The old `bindingKind !== 'correlated'` test was dropped (subsumed). The explanatory comment was retargeted to the flag and expanded to mention the wrapped/singleton-IN shapes.

### Test changes (`constraint-extractor.spec.ts`)

- Updated the parent fix's two cover-guard unit tests that set only `bindingKind = 'correlated'` to also set `correlated = true` (the guard no longer reads `bindingKind`). **Reviewer: confirm this is the right call** — these are synthetic constraints built directly (bypassing extraction), so they must carry the flag the guard now reads. Real extraction sets both.
- Added cover-guard unit tests: correlated singleton IN does NOT cover; non-correlated singleton IN (`[1]`) still covers; correlated wrapped-`'expression'` does NOT cover; same-table `'expression'` (no flag) still covers.
- Added a new `describe('correlated flag (row-scope escape)')` block with extraction tests (see "Use cases" below).

## Use cases / behavior to validate

| Predicate | Extracted? | `bindingKind` | `correlated` | Covers PK? |
|---|---|---|---|---|
| `p.id = outer.id` (bare other-table) | yes | `correlated` | `true` | no |
| `p.id = cast(outer.id)` (cast-wrapped other-table) | yes | `correlated` | `true` | no |
| `p.id = cast(p.b)` (cast-wrapped same-table) | yes | `expression` | `false` | yes |
| `p.id = p.b` (bare same-table) | yes | `expression` | `false` | yes |
| `p.id = :param` | yes | `parameter` | `false` | yes |
| `p.id = 5` (literal) | yes | `literal` | unset/falsy | yes |
| `p.id IN (outer.id)` | yes | `mixed` | `true` | **no (was yes — the bug)** |
| `p.id IN (:p1)` | yes | `mixed` | `false` | yes (singleton) |
| `p.id = outer.id + 1` (general expr) | **no — residual** | — | — | n/a |

All 229 cases in the spec pass; full quereus suite: 3197 passing.

## HONEST GAP — read before reviewing

The ticket's **Gap 1** assumed `p.id = outer.id + 1` "lands in `'expression'`" and reaches the cover guard. **It does not.** `extractBinaryConstraint`'s column-constant pattern guard (lines ~307/314) only matches when the value side is a literal or passes `isDynamicValue` (= a `ParameterReference` or `ColumnReference` after a single `unwrapCast`). A `BinaryOp` / `coalesce` / `cast(expr)` value side fails this guard and the whole predicate falls to **residual** — it is never turned into a constraint, so it never reaches `computeCoveredKeysForConstraints`. Consequently:

- The `else { bindingKind = 'expression'; }` branch at line ~369 is effectively **unreachable for the equality path** — only literal/param/column-ref value sides survive the guard.
- Gap 1's arithmetic shape (`outer.id + 1`) was therefore **already safe** (residual → relation classified `'global'`, no per-tuple misdispatch). There was no live false-positive to fix there via this code path.
- The only *reachable* "wrapped correlated" shape is a single `cast(bareColumn)` (because `unwrapCast` peels exactly one cast to expose a column ref). That case IS now flagged correctly and is tested.

**What this means for the fix's value:**
- The genuinely impactful change is **Gap 2 (singleton correlated `IN`)** — `p.id IN (outer.id)` *was* extracted and *was* wrongly covering the key; it is now correctly excluded. This is a real latent-bug fix.
- The `correlated` flag + full child walk is the right, future-proof mechanism: should extraction ever broaden to accept general-expression value sides, the flag already computes correctly via the recursive walk. It is correctly wired for `cast(bareCol)` today.

**Suggested reviewer actions / open questions:**
1. Decide whether to broaden `extractBinaryConstraint` to extract general-expression value sides (`outer.id + 1`, `coalesce(outer.id, 0)`). The ticket explicitly said *not* to (scope/risk: extracting more constraints changes pushdown behavior broadly), and it isn't needed for correctness since such predicates are correctly handled as residual. If a future caller *does* surface these as covering constraints through a different path (e.g. a vtab optimizer exposing seek keys derived from such expressions), the flag mechanism is ready — but verify whether such a path exists. The parent ticket noted MemoryTable hides seek keys from `getPredicates`, so its IndexSeek path doesn't feed `extractConstraintsForTable` regardless.
2. Confirm the free-reference walk's `getChildren()` traversal is the correct child accessor for scalar subtrees (it mirrors `findTargetRelationKey` at line ~256, which uses the same pattern). No `getRelations()` descent is done — intentional, since we only want scalar column refs in the value expression, not refs inside nested subqueries. **Worth a sanity check**: a value side containing a scalar subquery would have its inner column refs collected too, which could over-flag. Not currently reachable (subquery value sides aren't extracted as constraints), but note it.
3. The `p.id IN (outer.id)` extraction relies on `isDynamicValue(colref) === true`; a cast-wrapped or arithmetic IN element behaves like the equality path (cast(col) extractable, expr not). Not separately tested for IN — minor coverage gap.

## How to run

```
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/planner/constraint-extractor.spec.ts" --colors
cd packages/quereus && yarn typecheck && yarn lint
```

Typecheck clean, lint clean, targeted spec 229 passing, full suite 3197 passing.
