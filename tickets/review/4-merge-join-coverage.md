description: Merge join emitter now exercised via PK-ordered join path
dependencies: none
files:
  packages/quereus/src/vtab/memory/module.ts
  packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts
  packages/quereus/test/logic/83-merge-join.sqllogic
----

## What changed

Two planner-level fixes enable the merge join path for PK-equi-joins on memory tables:

1. **Memory module advertises inherent PK ordering** (`module.ts`): B-tree scans
   produce rows in PK order, but the access plan never reported this unless an
   explicit `ORDER BY` matched the PK.  Now, when there is no `requiredOrdering`
   and the plan uses the primary index, `providesOrdering` is set to the PK
   column specs.  This causes the access-path rule to emit `IndexScanNode` with
   ordering metadata instead of a bare `SeqScan`.

2. **Equi-pair reordering for multi-column PKs** (`rule-join-physical-selection.ts`):
   `extractEquiPairs` decomposes AND-trees via a stack, which reverses multi-column
   equi-pair order.  `isOrderedOnEquiPairs` requires positional matching against
   the source ordering, so reversed pairs fail the check.  Added
   `reorderEquiPairsForMerge()` which permutes equi-pairs to match both sources'
   physical ordering prefix before costing the merge join.

## Tests added (`83-merge-join.sqllogic`)

- PK inner join (single-column) with plan-shape assertion (`MergeJoin`)
- PK left join with unmatched rows
- Semi join via `EXISTS` on PK
- Anti join via `NOT EXISTS` on PK
- Partial PK overlap (some keys don't match)
- Multi-column composite PK join with plan-shape assertion
- Multi-column PK left join
- Empty table edge cases (inner + left)

## Coverage

`emit/merge-join.ts`: **17% / 0 functions -> 90.8% / 100% functions**

## Out of scope

- `emit/sequencing.ts` (29%, 0 funcs): Dead code. `SequencingNode` is never
  instantiated; there's a TODO in `select-window.ts:42` to use it for
  `ROW_NUMBER()` without `PARTITION BY`, but currently all window functions go
  through `WindowNode`.  Separate feature ticket if desired.

- `emit/retrieve.ts` (47%, 0 funcs): Intentional safety fallback. The emitter
  throws an error if a `RetrieveNode` survives optimization (it should always
  be rewritten to a physical access node).  Not reachable in practice.
