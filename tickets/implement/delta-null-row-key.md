---
description: Make AssertionEvaluator's `'row'` residual NULL-safe per nullable key column. Today the row path always emits `col = :pk_i`; when `chooseRowKey` falls back to a nullable unique key, NULL-keyed change tuples are silently skipped (same shape as the group bug fixed in delta-null-group-key).
files:
  - packages/quereus/src/core/database-assertions.ts
  - packages/quereus/src/planner/analysis/binding-extractor.ts
  - packages/quereus/test/logic/95-assertions.sqllogic
  - docs/incremental-maintenance.md
prereq: delta-null-group-key
---

## Background

`tryWrapTableReference` (`packages/quereus/src/core/database-assertions.ts:467`) builds the per-relation residual filter. The post-delta-null-group-key shape is:

```ts
const nullSafe = paramPrefix === 'gk';
for (let i = 0; i < keyColumns.length; i++) {
    // builds `col = :prefix_i`, then wraps in
    //   (col IS NULL AND :prefix_i IS NULL) OR col = :prefix_i
    // only when `nullSafe` is true (i.e. group bindings).
}
```

The scoping rationale ("PK columns are NOT NULL") holds when `chooseRowKey` (`binding-extractor.ts:107`) actually picks the PK. But it falls back to the lex-min covered unique key when the PK is not in `coveredKeys`:

```ts
function chooseRowKey(pkIndices: number[], coveredKeys: readonly number[][]): number[] {
    if (pkIndices.length > 0) { /* return pk if pk is in covered */ }
    // lex-min covered key fallback
    return sorted[0];
}
```

Quereus follows the SQL standard for UNIQUE (multiple NULLs allowed — `store-table.ts:checkUniqueConstraints` short-circuits when any covered column is NULL), so a nullable column can legitimately be part of a UNIQUE key and selected as the row binding. In that case the residual `col = :pk_i` evaluates UNKNOWN for NULL-keyed changed tuples and the inner scan returns nothing — the same silent-miss the prior ticket fixed on the group side.

## Architecture / approach

Take the **targeted per-column** approach (Option 2 in the fix ticket):

1. In `tryWrapTableReference`, replace the single `nullSafe = paramPrefix === 'gk'` flag with a per-column check on `attributes[colIdx].type.nullable`. Wrap with the OR-of-IS-NULL form **only** when the column is nullable; keep plain `=` for guaranteed-NOT-NULL columns.

2. This preserves the simple `col = :pk_i` form for PK-bound row residuals (and for any non-nullable column inside a group binding too — a nice side-effect that subsumes the group case symmetrically). Optimizer behaviour on the dominant PK-row path is unchanged.

3. The `paramPrefix === 'gk'` flag becomes redundant: every column's null-safety is now determined from its own type. Drop the flag from the predicate-build loop. (The flag is still needed for the parameter *name* — keep it for that.)

Why not Option 1 (unconditional NULL-safe)? The prior ticket's review flagged a potential regression in index-driven access for `FilterNode(TableReferenceNode, eq-pred)` when the predicate becomes disjunctive. Even if modern optimizers can prove `col IS NULL` is false for NOT NULL columns and fold the OR back to `=`, we don't want a bug fix to depend on that proof. Option 2 keeps the textually-simple `=` predicate on the hot path.

### Predicate shape (after fix)

For each column `keyColumns[i]` with `colIdx = keyColumns[i]`:

```
attributes[colIdx].type.nullable === false
  ⇒ emit `col = :prefix_i`               (unchanged)
attributes[colIdx].type.nullable === true
  ⇒ emit `(col IS NULL AND :prefix_i IS NULL) OR col = :prefix_i`
```

`prefix` is `'pk'` for row bindings, `'gk'` for group bindings (param name only).

### Bonus: defensive note on `chooseRowKey`

The fix ticket flags that `chooseRowKey` ideally would *avoid* picking a nullable unique key when an equivalent PK-covering plan is reachable. Today the function only picks PK when the PK columns themselves appear in `coveredKeys`. In practice the optimizer's FD/EC closure usually does propagate `UNIQUE_col → PK_col` so the PK IS covered (and chosen). When closure fails, we fall through. **Out of scope for this ticket** — leave `chooseRowKey` alone; the residual fix is the correctness backstop.

## Reproduction & tests

The bug requires the row binding to land on a nullable unique key. In practice this is hard to force — Quereus's FD/EC closure typically expands equality on a `UNIQUE` column into equality on the PK via the `UNIQUE → other_cols` FD, so the PK becomes covered and `chooseRowKey` picks it. Triggers we expect to work:

- A FilterNode subtree where the equality is on a nullable UNIQUE column and FD propagation is broken by an intervening node (Project that drops PK, SetOp branch, …). Verify via `explain_assertion`'s `prepared_pk_params` that the chosen param name maps to the nullable key column rather than `pk0` = PK.
- A scalar subquery context where the equality enters as `col = (scalar)` (subqueries aren't extracted as covered constraints today — `extractBinaryConstraint` requires literal/dynamic, not subquery, on the RHS — so this won't classify as `'row'`. Don't waste time on this shape.)

When deriving the shape, lean on `SELECT prepared_pk_params FROM explain_assertion('<name>')` to confirm classification and binding. The fix doesn't depend on demonstrating the bug — the residual builder is contractually NULL-safe per column type after this lands — but adding at least one regression test that hits the nullable-unique-key path is required.

If a SQL shape that forces a non-PK row binding can't be derived in a reasonable time-box, fall back to:

- An `explain_assertion`-shape test that asserts the row binding for a specific assertion lands on the PK (regression guard for `chooseRowKey`'s PK-preferred behaviour).
- A unit-level test in `packages/quereus/test/` that directly exercises `tryWrapTableReference` with a synthetic `keyColumns` referencing a nullable column, and asserts the residual contains an `IS NULL` leg per nullable column. (See whether the existing test infrastructure exposes the residual; if not, this is acceptable as a docstring/inline note rather than a test.)

## TODO

- Update `tryWrapTableReference` in `packages/quereus/src/core/database-assertions.ts:467` to use per-column nullability:
  - Replace `const nullSafe = paramPrefix === 'gk'` with a per-iteration `const colNullable = attributes[colIdx].type.nullable === true`.
  - Wrap the conjunct with the IS-NULL OR form only when `colNullable`.
  - Keep `paramPrefix` for the parameter *name* construction unchanged.

- Update the comment block above the loop (currently explaining the gk-vs-pk asymmetry) to describe the per-column-nullable rationale.

- Investigate `chooseRowKey` behaviour for a query whose equality is on a nullable UNIQUE column. Use `explain_assertion`'s `prepared_pk_params` to determine which key gets picked. Expected: PK via FD closure. If a shape can be found where the nullable key is picked, codify it in `95-assertions.sqllogic` as a new block (`rnn_*` for "row nullable not-null", following the `onn_*`/`oiso_*` naming).

- At minimum, add one `95-assertions.sqllogic` block that exercises a nullable UNIQUE column in a row-classified assertion (even if the binding ends up on PK), to guard against regressions in the binding picker and the residual builder. Pattern after `onn_nonneg` (single-column NULL case) and `omv_nonneg` (UPDATE moving rows across NULL boundary).

- Update `docs/incremental-maintenance.md`'s "First consumer: AssertionEvaluator" section: replace the row-vs-group asymmetry note with the unified per-column-nullable rule.

- Run `yarn workspace @quereus/quereus run lint` and `yarn test`. Pre-existing `@quereus/sample-plugins` failures (`key_value_store virtual table supports delete/update`) are not blocking — they were already flagged in the delta-null-group-key review.

- Skip `yarn test:store` unless the change accidentally touches the store path (it shouldn't — this is planner-rewrite layer). Note in handoff that a release should re-run it.
