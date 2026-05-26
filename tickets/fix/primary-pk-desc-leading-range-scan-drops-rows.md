---
description: Range scan on the leading column of a composite PRIMARY KEY whose leading column is DESC drops all matching rows (primary scan branch lacks isDescFirstColumn handling)
files: packages/quereus/src/vtab/memory/layer/scan-layer.ts, packages/quereus/src/vtab/memory/utils/primary-key.ts, packages/quereus/test/logic/05.1-composite-pk-range-scan.sqllogic
---

## What is wrong

A range scan constrained on the **leading column** of a **composite primary
key whose leading column is declared `DESC`** returns **zero** matching rows
(or the wrong subset).

Reproduction (memory vtab):

```sql
PRAGMA default_vtab_module='memory';
CREATE TABLE td (a INTEGER, b INTEGER, v TEXT, PRIMARY KEY (a DESC, b));
INSERT INTO td VALUES (10, 0, 'x'), (20, 0, 'y'), (30, 0, 'z');

SELECT a FROM td WHERE a >= 15 ORDER BY a;
-- expected: [{"a":20},{"a":30}]
-- actual:   []   (zero rows)
```

The chosen plan is `IndexSeek(INDEX RANGE td USING primary)` feeding a `Sort`,
i.e. a forward scan of the primary BTree.

## Root cause

The primary BTree for `PRIMARY KEY (a DESC, b)` is physically ordered with
`a` **descending**: `[30,0], [20,0], [10,0]`. The matching rows for `a >= 15`
sit at the **front** of that physical order.

The primary branch of `scanLayer` (`scan-layer.ts` ~L57-70) builds its seek
`startKey` from `plan.lowerBound` and then iterates **forward** from there. It
has **no `isDescFirstColumn` handling** — unlike the secondary-index branch
(L122, L130-133, L162-167), which detects a DESC leading column and instead
seeks from the upper bound / start and treats the lower bound as the
*termination* condition.

With the lower-bound wrap added by `composite-pk-range-scan-drops-rows`
(`startKey = [15]`), the composite comparator (which honors `def.desc`, see
`primary-key.ts` L119-137) positions `[15]` between `[20,0]` and `[10,0]` in
DESC order. The forward scan therefore *starts* at `[10,0]`, which fails the
`a >= 15` predicate, and the ascending early-exit guard
(`!plan.descending && plan.upperBound`, L89) does not fire because there is no
upper bound — so the scan yields nothing.

This is a **pre-existing** gap, not a regression: before the wrap the scalar
seek key compared as garbage against the array-shaped DESC keys, so this case
never worked. The ASC-leading composite fix and the secondary-index DESC path
are both correct and covered by `05.1-composite-pk-range-scan.sqllogic`; only
the **primary** branch's DESC-leading path is broken.

## What's needed

Port the secondary branch's DESC-leading-column logic into the primary branch:

- When the composite PK's leading column is `desc`, an ascending physical scan
  should seek from the **upper bound** (or tree start when absent) and use the
  **lower bound** as the early-termination condition (mirror L162-167:
  break once the key drops below the lower bound).
- Detect the leading-column direction from `schema.primaryKeyDefinition[0].desc`
  (guard the all-columns fallback where `primaryKeyDefinition` is `undefined` —
  the synthesized definition has no `desc`, so leading-DESC cannot arise there).
- Keep the existing ASC path and the composite lower-bound array wrap unchanged.
- Also sanity-check the `descending` scan direction interaction (e.g.
  `order by a desc` over a DESC-leading PK with a bound), which is likewise
  untested today.

## Test

Add to `05.1-composite-pk-range-scan.sqllogic` (or a sibling): a DESC-leading
2- and 3-column composite PK with `>=`, `>`, and `>= … <` leading-column
ranges, asserting all matching rows are returned. The secondary-index
DESC-leading case is already covered there (passing) and can serve as the
oracle for expected results.
