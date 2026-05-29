description: Extend the covering-structure coverage prover to admit a left/right outer-join body as covering a single-table UNIQUE constraint when T provably contributes exactly one MV row per governed T row (no row loss + no fan-out). Reviewed and completed.
files: packages/quereus/src/planner/analysis/coverage-prover.ts, packages/quereus/test/covering-structure.spec.ts, docs/materialized-views.md, docs/optimizer.md
----

## What landed

`proveCoverage` (`planner/analysis/coverage-prover.ts`) now descends through
binary joins and admits a join body when T contributes **exactly one MV row per
governed T row**, decomposed into two independent obligations:

- **No row loss (≥1)** — structural plan-walk gate: T must be on the *preserving*
  side of every join (`left`→left subtree, `right`→right subtree). All other
  join types/positions ⇒ `shape`.
- **No fan-out (≤1)** — `isUnique(T.pk, topmostJoin)` against the **join-frame**
  FDs (deliberately not the projected body root). New `'fanout'`
  `CoverageFailureReason`.

A name-collision guard (`proveJoinOneToOne`) rejects bodies where a lookup-side
column reuses a UC (or UC-predicate) column name, since the AST ORDER BY / WHERE
checks resolve columns by bare name. `Alias` was added to `PASS_THROUGH`.

All v1 single-source behavior is unchanged. The constraint↔structure link
(`linkCoveredUniqueConstraints`) remains informational — nothing enforces through
the MV's backing table yet. Inner/cross-via-FK and full-outer covering remain
deferred (`tickets/backlog/coverage-prover-inner-join-fk-preservation.md`).

## Review findings

### Scope of the review

Read the full implement diff (34b8fb1c) with fresh eyes before the handoff
summary, then traced every soundness claim through the supporting code:
`propagateJoinFds` / `analyzeJoinKeyCoverage` / `combineJoinKeys`
(join FD + key derivation), `isUnique` / `keysOf` / `deriveKeysFromFds`
(uniqueness read surface), `CapabilityDetectors.isJoin` + the JoinCapable node
classes, `collectColumnNames` / `columnIndexFromExpr` (bare-name resolution).
Build, lint, and the full quereus test suite were run.

### Soundness — verified, no findings

The central deviation from the implement ticket (fan-out gate at the **join
frame**, not the projected root) is **correct and load-bearing**. Confirmed
against the code, not just the prose:

- **Fanout LEFT join** (`analyzeJoinKeyCoverage` 'left' branch, key-utils.ts:394):
  when the lookup join column is non-unique, `rightKeyCovered` is false ⇒
  `preservedKeys` is empty ⇒ `propagateJoinFds` 'left' (join-utils.ts:244) emits
  only `leftFds` = `T.pk → T-cols`. `combineJoinKeys` 'left' returns `[]`. At the
  join frame `isUnique(T.pk, topJoin)` is false (T.pk's closure does not reach the
  retained lookup columns; no declared/derived key ⊆ T.pk) ⇒ `'fanout'`. Faithful.
- **1:1 LEFT join**: `rightKeyCovered` true ⇒ `preservedKeys` includes T's keys ⇒
  `withKeyFds` adds `T.pk → all_join_cols` ⇒ `isUnique` true. Correct.
- **Projected-root trap** confirmed real: after projecting away lookup columns,
  `T.pk → T-cols` makes T.pk a derived key of the narrowed relation, so a
  root-frame check would falsely report unique in the fanout case. The
  implementer's choice avoids this.
- **Name-collision guard** is sufficient *and* has backstops: a lookup column
  reusing a UC/UC-predicate column name could produce a false `Covers` via
  bare-name misresolution and is guarded (→ `shape`). Collisions with *other* T
  columns (non-UC, non-PK) are independently caught by the ORDER-BY permutation
  check or the predicate-alignment *completeness* check, so they cannot yield a
  false `Covers`. The PK-name exemption is sound: the PK is consumed only via
  stable attribute ids, and any PK-name misresolution in ORDER BY/WHERE fails
  permutation or completeness. (The canonical `orders.id`/`customers.id` both
  named `id` works precisely because of this exemption.)
- **Nested joins**: topmost-join capture composes correctly — a fan-out below the
  top join is still caught because the top frame's FDs don't let T.pk reach the
  fanning side's columns (verified by a new test, see below).
- **Self-join / T on both sides / T in a lookup subquery**: all rejected as
  `shape` via the both-sides ambiguity check in `subtreeContainsConstrainedTable`.
- **New `'fanout'` reason**: no exhaustive `switch` over `CoverageFailureReason`
  exists anywhere; the sole consumer (`linkCoveredUniqueConstraints`) reads only
  `result.covers`. No breakage.

### Tests — extended (minor, fixed in this pass)

The implementer's suite was a sound floor (single-join positive/negative per
obligation, eager-link both ways). Added 4 tests to
`test/covering-structure.spec.ts` § "multi-source (join) bodies" closing the gaps
the handoff itself flagged:

- **positive: nested LEFT joins, both 1:1, cover** — exercises the topmost-join
  capture + per-join structural gate over a 2-join chain.
- **negative fanout: nested LEFT joins where the OUTER join fans out** — the
  important soundness test: inner join 1:1 but outer join fans out; confirms the
  join-frame check catches a fan-out deeper than a single join.
- **positive: composite-PK table maps every PK attribute into the join frame** —
  2-column PK joined 1:1 on a non-colliding column; confirms the fan-out gate maps
  *all* PK attributes, not just the first.
- **negative shape: join on a UC column whose lookup side reuses that column
  name** — pins the name-collision guard. (Discovered while writing the
  composite-PK test: the natural `l.sku = p.sku` join is correctly rejected as
  `shape` because `products.sku` collides with the UC column `sku`. This is sound
  but a real **completeness limitation** — see major findings.)

Full suite after changes: **3783 passing, 0 failing, 9 pending** (the 9 pending
are pre-existing; no `.pre-existing-error.md` needed — nothing failed).
Build clean, lint clean.

### Docs — verified accurate

`docs/materialized-views.md` § Covering structures and `docs/optimizer.md` §
Coverage proving were read in full and correctly describe the join admit path,
both obligations, the join-frame rationale, the join-elimination collapse to the
v1 path, and the new `coverage-prover-inner-join-fk-preservation` deferral (ticket
confirmed present in `backlog/`). No doc drift found. (Minor: the name-collision
guard is documented thoroughly in the module doc but not in the two prose docs —
left as-is; the prose docs are intentionally higher-altitude.)

### Major findings — filed, not fixed inline

- **Completeness limitation: lookup column reusing a UC/UC-predicate column name
  is always rejected.** The bare-name resolution in the ORDER BY / WHERE checks
  forces the guard to reject any otherwise-1:1 join whose lookup side reuses a UC
  column name (e.g. `line_items l left join products p on l.sku = p.sku` covering
  `unique(oid, sku)`). This is *sound* (conservative `shape`) but forgoes a valid
  optimization. The clean fix is qualifier-aware column resolution in the AST
  checks (resolve `alias.col` against the bound source rather than by bare name),
  after which the guard could be dropped entirely. Filed as
  `tickets/backlog/coverage-prover-qualified-name-resolution.md`.

### Empty categories

- **No new fix tickets for correctness** — the soundness contract holds.
- **No performance findings** — the join walk is O(plan depth) and the fan-out
  gate is one `isUnique` call; both run only in the best-effort eager-link path.
- **No resource-cleanup / error-handling findings** — pure analysis, no I/O,
  conservative fall-through to `shape` on anything unrecognized.
