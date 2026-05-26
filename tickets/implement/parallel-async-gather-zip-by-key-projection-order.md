description: Broaden `rule-async-gather-zip-by-key` recognition beyond the single canonical projection layout, so full-outer-on-shared-key queries with arbitrary SELECT ordering (and `USING`/`NATURAL` joins) fold to `AsyncGatherNode(zipByKey)` instead of hard-erroring at emit.
files: packages/quereus/src/planner/rules/parallel/rule-async-gather-zip-by-key.ts, packages/quereus/test/optimizer/parallel-async-gather-zip-by-key.spec.ts, docs/optimizer.md
----

## Problem

`rule-async-gather-zip-by-key` only recognizes the **exact** canonical
projection layout the `zipByKey` emitter produces:

```
[ K coalesce(group) calls ] ++ [ branch0 non-key refs, branch1 non-key refs, … ]
```

Any other shape is silently not recognized:

- key columns not first, or interleaved with non-key columns
  (`select a.av, coalesce(a.k, b.k) k, b.bv …`),
- non-key columns reordered or a subset selected,
- extra/derived columns in the SELECT list,
- `USING(k)` / `NATURAL` full joins (the builder may not emit an explicit
  `coalesce` over the equated columns — currently untested).

Because **binary `FULL JOIN` has no runtime lowering of its own**, a
non-recognized full-outer query does not merely run slower — it falls through to
the unsupported `JoinNode(full)` and **errors at emit** (`FULL JOIN is not
supported`). So a plausible, perfectly valid user query like
`select a.av, coalesce(a.k, b.k) as k, b.bv from a full outer join b on a.k = b.k`
fails hard today.

## Desired behavior

Recognize the full-outer-on-shared-key shape regardless of SELECT column order,
and project the gather's canonical output into the user's requested order with a
thin reordering `Project` on top of the `AsyncGatherNode(zipByKey)`:

1. Match the join chain + key-equality + shared-key + key-uniqueness gates as
   today (these are layout-independent).
2. Identify the K merged-key outputs (each a `coalesce` over a full key group)
   and the forwarded non-key column refs **anywhere** in the projection list,
   allowing arbitrary order and arbitrary additional pure scalar expressions
   over those outputs.
3. Build the gather in its canonical layout, then wrap it in a `Project` that
   reorders/derives to the user's actual projection list. (When the projection
   already happens to be canonical, skip the wrapper — the current fast path.)
4. Decide `USING`/`NATURAL`: confirm what shape the builder emits and either
   recognize it directly or document it as still out of scope.

## Acceptance

- `select a.av, coalesce(a.k, b.k) as k, b.bv from a full outer join b on …`
  (and other reorderings) fold and return correct full-outer-merge rows.
- Selecting a subset of non-key columns, or a derived expression over the merged
  key, folds and is correct.
- `USING(k)` full join: either folds correctly or has an explicit test pinning
  the documented non-support.
- `docs/optimizer.md` § *Async gather ZIP BY KEY* updated: the "canonical order
  only" limitation is lifted (or narrowed) accordingly.

## Notes

Out of scope (still): `LEFT`/`RIGHT` outer chains — `zipByKey` is symmetric
full-outer only.
