---
description: Fix primary-BTree range scan dropping all rows when the leading column of a composite PRIMARY KEY is DESC; port the secondary-index isDescFirstColumn handling into the primary branch of scanLayer
files: packages/quereus/src/vtab/memory/layer/scan-layer.ts, packages/quereus/src/vtab/memory/layer/plan-filter.ts, packages/quereus/src/vtab/memory/layer/safe-iterate.ts, packages/quereus/src/vtab/memory/utils/primary-key.ts, packages/quereus/test/logic/05.1-composite-pk-range-scan.sqllogic
---

## Problem (confirmed reproduced)

A range scan constrained on the **leading column** of a **composite primary key
whose leading column is declared `DESC`** returns **zero** matching rows.

Reproduced against the memory vtab (`yarn test`, logic harness):

```sql
PRAGMA default_vtab_module='memory';
CREATE TABLE td (a INTEGER, b INTEGER, v TEXT, PRIMARY KEY (a DESC, b));
INSERT INTO td VALUES (10, 0, 'x'), (20, 0, 'y'), (30, 0, 'z');
SELECT a FROM td WHERE a >= 15 ORDER BY a;
-- expected: [{"a":20},{"a":30}]   actual: []  (Row count mismatch. Expected 2, got 0)
```

## Root cause (verified against source)

The primary BTree for `PRIMARY KEY (a DESC, b)` is physically ordered with `a`
descending: `[30,0], [20,0], [10,0]`. The composite comparator in
`primary-key.ts` (`createCompositeColumnPrimaryKeyFunctions`, L119-137) honors
`def.desc`, negating the per-column comparison for DESC columns.

The **primary** branch of `scanLayer` (`scan-layer.ts` L57-99) builds its seek
`startKey` only from `plan.lowerBound` (wrapped in a single-element array for
composite PKs, L63-70) and then iterates **forward** from there. It has **no
`isDescFirstColumn` handling**.

With `startKey = [15]`, the DESC-aware comparator positions `[15]` between
`[20,0]` and `[10,0]` in physical (descending) order. `safeIterate` therefore
*starts* the forward scan at `[10,0]`, which fails the `a >= 15` predicate in
`planAppliesToKey`. The ascending early-exit guard at L89
(`!plan.descending && plan.upperBound && !plan.equalityPrefix`) never fires
because there is no upper bound — so the loop `continue`s to the end and yields
nothing. The matching rows (`[30,0]`, `[20,0]`) sat at the **front** of the
physical order, before the seek position, and are never visited.

The **secondary-index** branch already handles this correctly (L120-175): it
detects `isDescFirstColumn` from the index definition and, for an ascending
physical scan, seeks from the **upper bound** (or tree start when absent) and
uses the **lower bound** as the early-termination condition (L162-167).

This is a **pre-existing gap**, not a regression from
`composite-pk-range-scan-drops-rows`: before that lower-bound array wrap landed,
the scalar seek key compared as garbage against the array-shaped DESC keys, so
this case never worked. The ASC-leading composite path and the secondary-index
DESC path are correct and covered by `05.1-composite-pk-range-scan.sqllogic`.

## Fix approach

Port the secondary branch's DESC-leading-column logic into the primary branch of
`scanLayer` (`scan-layer.ts`, the `if (plan.indexName === 'primary')` block):

1. **Detect leading-column direction.** Use
   `schema.primaryKeyDefinition?.[0]?.desc === true`. Guard the all-columns
   fallback: when `primaryKeyDefinition` is `undefined` the synthesized
   definition has no `desc` (see `primary-key.ts` L22-24), so leading-DESC cannot
   arise there — the `?.` chain naturally yields `false`, which is correct.

2. **Pick the seek start key by direction** (for the non-`equalityPrefix`,
   non-`equalityKey` range path). Mirror the secondary branch L130-143:
   - `isDescFirstColumn` → seek from `plan.upperBound` when present (wrapped in a
     single-element array for composite, matching the existing lower-bound wrap
     at L67-68), else `undefined` (tree start).
   - else (ASC leading) → keep the existing lower-bound wrap behavior (L63-70).

   The composite-vs-scalar wrap decision is the same in both cases:
   `isComposite = (schema.primaryKeyDefinition?.length ?? schema.columns.length) > 1`.

3. **Add the DESC-leading early-termination** in the
   `!planAppliesToKey(...)` block. Mirror the secondary branch L161-174: for an
   ascending physical scan (`!plan.descending`), when `isDescFirstColumn` and
   `plan.lowerBound` is present, break once the key's leading column drops below
   the lower bound:

   ```ts
   const keyForComparison = Array.isArray(primaryKey) ? primaryKey[0] : primaryKey;
   const cmp = compareSqlValues(keyForComparison, plan.lowerBound.value);
   if (cmp < 0 || (cmp === 0 && plan.lowerBound.op === IndexConstraintOp.GT)) break;
   ```

   Keep the existing ASC early-exit guard (L89-95) for the non-DESC case. Be
   careful to preserve the `equalityPrefix` prefix-mismatch break (L77-87) ahead
   of the bound checks — the new branch should sit alongside the existing
   `!plan.descending && plan.upperBound && !plan.equalityPrefix` guard, not
   replace it.

4. **Sanity-check the `plan.descending` interaction.** When `plan.descending` is
   true (physical scan walks the tree backward via `safeIterate(..., false)`),
   the DESC-leading PK is walked in ascending logical order. Verify the bound and
   start-key selection still produce correct results for e.g.
   `order by a desc` over a DESC-leading PK with a leading-column bound. Add test
   coverage; adjust the start-key / termination logic only if a test fails (the
   secondary branch keys all of its DESC handling off `isAscending`, so consider
   gating the primary branch's new logic the same way rather than off
   `!plan.descending` raw — match whichever the secondary branch uses for
   consistency).

Do **not** change the ASC-leading composite path or the lower-bound array wrap —
they are correct and regression-covered.

## Test

Extend `packages/quereus/test/logic/05.1-composite-pk-range-scan.sqllogic` with a
DESC-leading PRIMARY KEY section (the secondary-index DESC case at L82-93 of that
file is the passing oracle for expected results). Cover:

- 2-column composite PK `(a DESC, b)` with `>=` between keys, `>=` on an exact
  key, `>` exclusive, and a `>= … <` leading-column range.
- 3-column composite PK with a DESC leading column and a leading-column range.
- `order by a desc` over a DESC-leading PK with a leading-column bound
  (descending-scan interaction).

The reproduced failing query `SELECT a FROM td WHERE a >= 15` over
`PRIMARY KEY (a DESC, b)` must return `[{"a":20},{"a":30}]`.

## TODO

- [ ] In `scan-layer.ts` primary branch: compute `isDescFirstColumn` from
      `schema.primaryKeyDefinition?.[0]?.desc === true`.
- [ ] Select seek `startKey` by direction (upper-bound seek + array wrap for the
      DESC-leading composite case; keep existing lower-bound wrap otherwise).
- [ ] Add DESC-leading early-termination (break when leading column drops below
      lower bound) alongside the existing ASC upper-bound early-exit guard.
- [ ] Confirm `plan.descending` interaction; gate the new logic to match the
      secondary branch's `isAscending` convention.
- [ ] Add the DESC-leading PK cases to `05.1-composite-pk-range-scan.sqllogic`
      (2-col, 3-col, and `order by … desc`).
- [ ] `yarn test` green (stream output with `tee`); `yarn lint` clean.
- [ ] Update `docs/` only if scan/index behavior is documented there (check
      `docs/optimizer.md` / `docs/schema.md`); otherwise no doc change needed.
