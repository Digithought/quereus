description: Review the whole-Sort elimination over a provably ≤1-row source added to `rule-orderby-fd-pruning`. A single-key (or any) ORDER BY over a relation proven to hold ≤1 row is now dropped entirely.
files: packages/quereus/src/planner/rules/sort/rule-orderby-fd-pruning.ts, packages/quereus/test/optimizer/rule-orderby-fd-pruning.spec.ts, docs/optimizer.md
----

## What was implemented

A relation with ≤1 row is trivially totally ordered, so an `ORDER BY` over it is a
pure no-op. The existing trailing-key logic in `rule-orderby-fd-pruning` could never
express this: it bailed on `sortKeys.length < 2` and always retained the first key
before checking `isUnique`, so the degenerate "0 leading keys already form a superkey"
case (the empty key) went unhandled.

**Change:** a guard at the very top of `ruleOrderByFdPruning`, *before* the
`sortKeys.length < 2` early-return:

```ts
if (isUnique([], node.source)) {
    return node.source;   // drop the SortNode entirely
}
```

`isUnique([], source)` is true iff the empty key is present in the unified key surface
(`keysOf`) — i.e. the source carries a `∅ → all_cols` singleton FD, a declared empty
key (TableDee), etc. This mirrors `rule-distinct-elimination`, which also returns
`node.source` to drop a redundant node. Returning the source is safe because
`SortNode.getType()`/`getAttributes()` already delegate to the source, so the parent
sees identical attribute identity.

Doc comment on the rule and the `docs/optimizer.md` consumer summary were updated.

## How to validate

Build + lint + targeted specs all pass:
- `yarn workspace @quereus/quereus run build`
- `npx eslint 'src/planner/rules/sort/rule-orderby-fd-pruning.ts' 'test/optimizer/rule-orderby-fd-pruning.spec.ts'`
- Specs: `test/optimizer/rule-orderby-fd-pruning.spec.ts` and
  `test/optimizer/monotonic-limit-pushdown.spec.ts` (34 passing together).

### Use cases / test surface (added to the spec)
- **Single-key ORDER BY over a scalar aggregate** (`SELECT c FROM (SELECT count(*) AS c FROM t) ORDER BY c`)
  — Sort eliminated (this is the headline gap the ticket targets; previously the
  `< 2` guard kept it).
- **Multi-key ORDER BY over a scalar aggregate** — Sort eliminated regardless of key count.
- **Behavioral**: `ORDER BY c` over the singleton source returns the single expected row.
- Pre-existing cases still hold: single-key sort over a **multi-row** source is untouched
  (`< 2` guard), trailing-key pruning unchanged.

## Known gaps / reviewer attention

- **Ordering physical-property regression risk (the ticket's explicit concern).** Dropping
  the Sort means the result no longer carries the `ORDER BY` columns in its physical
  `ordering`. I argued this is safe: (a) a ≤1-row relation satisfies *any* ordering, so no
  consumer can observe a wrong order; (b) my rule is in the **Structural** pass, which
  completes before physical-selection passes that might insert order-requiring Sorts (e.g.
  merge join), so there is no oscillation where a later-inserted Sort gets re-stripped. I
  verified the full `@quereus/quereus` suite (527 passing) shows no plan regressions, but I
  did **not** hand-construct a plan where an outer operator strictly depends on the declared
  ordering string of a ≤1-row source — worth a targeted probe (e.g. a merge join or
  streaming distinct fed by a singleton side).
- **Coverage floor.** The new tests use scalar aggregates as the ≤1-row source. Other
  singleton sources (TableDee/`VALUES` single row, joins that propagate the singleton FD,
  and `LIMIT 1` once `limit-one-singleton-fd` lands) are not directly asserted here — they
  flow through the same `isUnique([], source)` check but are untested in this spec.
- **Pre-existing flaky failure** is documented in `tickets/.pre-existing-error.md`:
  `Optimizer Equivalence › predicate pushdown rules produce identical results` failed once
  during a full-suite run (blob truthiness in `HAVING`, disabled rules
  `[predicate-pushdown, filter-merge]`, query has no ORDER BY). It passed 20/20 isolated
  runs on both `main` and this branch and is structurally unreachable by this change. The
  runner's triage pass should handle it.
