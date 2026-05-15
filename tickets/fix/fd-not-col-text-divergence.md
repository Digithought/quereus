---
description: Consumer-side `NOT col → literalEqs(col, 0)` rewrite is unsound for non-numeric columns. `WHERE NOT col` and `WHERE col = 0` are equivalent only for NUMERIC/BOOLEAN-typed columns; for TEXT/BLOB/OBJECT, NOT excludes only "falsy" values (incl. '') while `=` 0 requires storage-class equality. A partial UC `WHERE col = 0` on a TEXT NOT NULL column produces a guarded FD `eq-literal{col, 0}` that the consumer (incorrectly) discharges from a `WHERE NOT col` filter, yielding an unconditional FD that claims uniqueness over rows the runtime UC never enforced.
files:
  packages/quereus/src/planner/util/fd-utils.ts
  packages/quereus/src/planner/analysis/partial-unique-extraction.ts
  docs/optimizer.md
  packages/quereus/test/optimizer/conditional-fds.spec.ts
---

## Reproducer

```sql
CREATE TABLE t (id INTEGER PRIMARY KEY, c INTEGER NOT NULL, val TEXT NOT NULL) USING memory;
CREATE UNIQUE INDEX ix ON t(c) WHERE val = 0;   -- Empty scope at runtime: TEXT '' != INT 0 (storage class).
INSERT INTO t VALUES (1, 1, '');                 -- Outside UC scope, allowed.
INSERT INTO t VALUES (2, 1, '');                 -- Outside UC scope, allowed (no UC violation).

-- Now query plan for `WHERE NOT val`:
EXPLAIN/query_plan: SELECT * FROM t WHERE NOT val
-- TABLEREFERENCE FD: c→{id,val} guarded by `eq-literal{val, 0}` (correct)
-- FILTER FD:        c→{id,val} unconditional (WRONG — two rows share c=1 in filter scope)
```

The FILTER node's unconditional FD is observably false: filter rows include `(1,1,'')` and `(2,1,'')`, both with `c=1`. Any optimizer rule that consumes this FD (DISTINCT/GROUP BY elimination, join-key inference, sort-elision, etc.) will produce wrong results. Today no rule visibly mis-fires on this exact shape, so the bug is latent — but the FD state is corrupt and any future rule could exploit it.

## Root cause

`fd-utils.ts:846-848` (`buildPredicateFacts`, UnaryOpNode 'NOT' branch):

```ts
else if (op === 'NOT') {
  literalEqs.set(cIdx, 0);
  isNotNullCols.add(cIdx);
}
```

This claims the filter pins `col` to literal `0`. That's only true when `NOT col ⟺ col = 0` semantically — i.e., for INTEGER/REAL/BOOLEAN columns where storage class is NUMERIC. For TEXT/BLOB/OBJECT columns the equivalence fails (`'' satisfies NOT but not = 0`; `'abc' fails NOT but might match = 0` only via affinity, which Quereus doesn't apply per `compareSqlValues`). The producer-side rewrite in `partial-unique-extraction.ts:186-191` has the symmetric problem but is benign by itself; it becomes unsound only when paired with the consumer's lossy `NOT col → col = 0` claim.

The producer's NOT-NULL gate at `recognizeClause` requires `tableSchema.columns[col]?.notNull === true` but is type-blind.

## Fix options

(a) **Drop the `literalEqs.set(cIdx, 0)` claim, keep `isNotNullCols.add(cIdx)`.**
    `WHERE NOT col` would no longer discharge `eq-literal{col, 0}` guards. Loss of feature: a `WHERE NOT col` filter no longer activates a `WHERE NOT col` partial UC (the test cases for §7j in `10.5.1-partial-indexes.sqllogic` and the related conditional-fds.spec cases would need to be re-examined). The `WHERE col = 0` filter still activates such a UC.

(b) **Gate the consumer rewrite on column type.** Require the column's logical type to be numeric (INTEGER/REAL/BOOLEAN) before pinning `literalEqs(col, 0)`. The `predicateImpliesGuard` signature already takes `attrIdToIndex`; teach `buildPredicateFacts` about a "column-is-numeric" predicate (similar to `isColumnNonNullable`). The producer-side rewrite should be gated symmetrically. Preserves the feature for the common case (boolean / int flags).

(c) **Both producer and consumer drop `NOT col` recognition entirely.** Simplest, smallest surface; loses the `WHERE NOT archived` feature added in this ticket. Probably overkill.

Recommended: (b). Type information is available on both sides — `tableSchema.columns[col].type` for the producer, and `isColumnNonNullable` is already a callback in the consumer (extend with `isColumnNumeric` or pass the source type directly).

## Test additions (regression)

- The reproducer above as a sqllogic case: assert the FILTER node does NOT activate the FD when the partial UC is `WHERE val = 0` and the filter is `WHERE NOT val`.
- A unit test in `conditional-fds.spec.ts` that constructs the same shape directly and asserts `predicateImpliesGuard` returns false for the filter `WHERE NOT val` against a guard `eq-literal{val, 0}` when `val`'s type is TEXT.

## Notes

- The consumer also adds `isNotNullCols.add(cIdx)` for `NOT col`. That is sound (the row passes the filter only when `col` is non-NULL, regardless of type) and should be kept.
- The end-to-end §7j test today insets only INTEGER NOT NULL columns, so the bug is invisible to the existing suite. After fix (b), §7j keeps working (INT path); a new TEXT-column case proves the fix.
- The implement-stage soundness probe #1 in `tickets/review/fd-guard-or-in-not-shapes.md` flagged this exact concern. The reviewer demonstrated it produces an observably-corrupt FILTER FD (verified via `query_plan` table function).
