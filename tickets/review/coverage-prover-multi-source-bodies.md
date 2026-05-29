description: Review the multi-source (join) extension of the covering-structure coverage prover — `proveCoverage` now admits a left/right outer-join body as covering a single-table UNIQUE constraint when T provably contributes exactly one MV row per governed T row (no row loss + no fan-out).
prereq:
files: packages/quereus/src/planner/analysis/coverage-prover.ts, packages/quereus/test/covering-structure.spec.ts, docs/materialized-views.md, docs/optimizer.md
----

## What landed

`proveCoverage` (`planner/analysis/coverage-prover.ts`) previously rejected any
body that was not a single linear chain to one `TableReferenceNode`. It now
descends through binary joins and admits a join body when T contributes **exactly
one MV row per governed T row**. All v1 single-source behavior is unchanged
(verified: the pre-existing positive/negative suites still pass).

Build: `yarn workspace @quereus/quereus run build` → clean.
Lint:  `yarn workspace @quereus/quereus run lint` → clean.
Tests: full `yarn workspace @quereus/quereus test` → **3779 passing, 0 failing**
(9 pending pre-existing). New cases live in `test/covering-structure.spec.ts` §
"coverage prover — multi-source (join) bodies".

### The 1:1 decomposition as implemented

- **No row loss (≥1)** — structural plan-walk gate: T must be on the *preserving*
  side of every join (`left`→left subtree, `right`→right subtree). `inner`/`cross`
  /`semi`/`anti`/`full`, and T on the dropping side, are rejected as `shape`. T on
  both sides (self-join) or neither ⇒ `shape`.
- **No fan-out (≤1)** — `isUnique(T.pk, topmostJoin)` against the join-frame FDs.

A new `'fanout'` reason was added to `CoverageFailureReason`.

## ⚠️ Deliberate deviation from the implement ticket — scrutinize this first

The ticket prescribed the fan-out gate as `isUnique(pkOutputCols, root)` on the
**projected body root**. **I found that unsound and instead check at the topmost
*join* frame.** The reviewer should independently confirm this reasoning:

- `TableReferenceNode.computePhysical` (reference.ts:106) seeds T's PK as a
  *physical* FD `pk → other-cols`. For `T LEFT JOIN L` this FD propagates to the
  join output via `leftFds` (join-utils.ts `propagateJoinFds` 'left' branch),
  **independently of** the preserved-key FD that only appears when L's key is
  covered.
- In the fanout case the join output therefore still carries `T.pk → T-cols`.
  Once the body projects away the lookup columns (the canonical orders-only
  projection), `projectFds` narrows that to a relation where `T.pk` closes over
  every remaining column ⇒ `T.pk` reads as a derived key of `root` ⇒
  `isUnique(pkOutputCols, root)` returns **true** even though the projected MV has
  duplicate T rows. A false `Covers`.
- Checking at the join frame (lookup columns still present) is faithful: the
  `T.pk → all_join_cols` FD is emitted *iff* the lookup key is covered, so
  `isUnique(T.pk, topJoin)` is false exactly when the lookup side can multiply a
  T row. The `negative fanout` test passing is the evidence; a reviewer could
  strengthen this by adding an assertion that the projected-root check returns
  the *wrong* answer for the same body (documents the trap).

T.pk is mapped into the join frame via stable attribute ids (`tableRef`
attributes → `topJoin` attributes); projection coverage still maps via the same
ids, so lookup-side attributes are simply absent from `baseAttrToCol`.

## Other deviations / decisions (all sound-strengthening — confirm)

1. **Name-collision guard (`proveJoinOneToOne`), not in the ticket.** The AST
   ORDER BY / WHERE checks resolve columns by **bare name** (`columnIndexFromExpr`
   ignores a table/alias qualifier). In a join body a lookup column sharing a UC
   (or UC-predicate) column's name would mis-resolve to T's column — a sort/filter
   on the *lookup* column could be wrongly accepted (false `Covers`). The guard
   rejects (`shape`) when any UC/UC-predicate column name collides with a
   lookup-side column name. PK names are **exempt** (PK is consumed only via
   attribute ids) — important, because the canonical case has `orders.id` /
   `customers.id` both named `id`. **Probe:** is the guard's column set complete?
   I cover `uc.columns` ∪ `collectColumnNames(uc.predicate)`. Partial-UC-on-join
   is not tested (no test exercises a partial UNIQUE over a join body).

2. **`Alias` added to `PASS_THROUGH`.** Join bodies introduce `AliasNode`s
   (`orders o`), which the v1 walk didn't traverse → it rejected the canonical
   case as `shape` until added. Alias is a row-preserving single-source wrapper,
   so this is also correct for aliased single-source bodies. **Probe:** any other
   row-preserving wrapper that can appear over T's side and isn't whitelisted?

3. **Join-node detection** uses `BINARY_JOIN_TYPES` (`Join`/`NestedLoopJoin`/
   `HashJoin`/`MergeJoin`) ∧ `CapabilityDetectors.isJoin`. The optimizer emits
   `BloomJoinNode` (nodeType `HashJoin`) for the canonical case. `FanOutLookupJoin`
   / `AsofScan` are not `JoinCapable` → they fall through to `shape`. No
   `NestedLoopJoin` node class exists today (the enum member is covered defensively).

4. **Commutation handled:** the structural gate keys off `leftHasT`/`rightHasT` +
   `joinType`, so a LEFT join represented as its RIGHT-join commute (or vice-versa)
   is accepted/rejected identically.

5. **ORDER BY qualifier — ticket's open question resolved.** The parser emits
   `alias.col` as `AST.ColumnExpr` (`type:'column'`, `table` set), which
   `columnIndexFromExpr` resolves by **bare name** (qualifier ignored). No
   qualifier-stripping was needed; the name-collision guard (1) covers the
   ambiguity that bare-name resolution would otherwise admit.

## Test coverage (this is a floor — extend it)

Positive: LEFT join to a unique lookup key (T on preserving left); RIGHT join with
T on preserving right. Negative: `fanout` (LEFT join on a non-unique lookup key);
`shape` for INNER join / T on dropping side / self-join; WHERE on a lookup column
rejected; eager-link stamps `covers`+`coveringStructureName` for a covering join MV
and stamps nothing for a fanning one.

**Known gaps a reviewer should consider closing:**
- **RIGHT JOIN is execution-unsupported** in quereus today (`emit/join.ts:35`
  throws), so a RIGHT-join MV cannot be materialized. The RIGHT-join positive is
  tested via `proveUnmaterialized` — it parses + plans the body and runs the
  prover against a minimal MV stub (only `mv.selectAst` is read). This exercises
  the `'right'` branch but does **not** exercise the eager-link path for a RIGHT
  join (which can't be created). Confirm the stub fairly represents a real MV.
- **Nested joins** (`(orders LJ customers) LJ addresses`) are handled by design
  (topmost-join capture + per-join structural gate + composed join-frame FDs) but
  have **no explicit test** — only single-join cases are covered. Worth adding.
- The `WHERE on a lookup column` test accepts reason ∈ {`shape`,
  `predicate-entailment`} because the optimizer may null-reject the LEFT join into
  an INNER join (→ `shape`) or leave it (→ AST predicate alignment rejects the
  non-T clause → `predicate-entailment`). Both are sound; a reviewer may want to
  pin the exact observed plan/reason.
- No multi-column-PK join test; no partial-UNIQUE-over-join test.

## Soundness contract (unchanged from v1)

A false `Covers` is unsound (the lens layer would later miss conflicts); a false
`NotCovers` only forgoes an optimization. Nothing enforces through an explicit
MV's backing table yet — the link is informational. The inner/cross-join-via-FK
path remains deferred (`tickets/backlog/coverage-prover-inner-join-fk-preservation.md`);
docs (`materialized-views.md` § Covering structures, `optimizer.md` § Coverage
proving) were updated to describe the join admit path, the two-obligation
soundness note, the join-frame rationale, and the new deferral.
