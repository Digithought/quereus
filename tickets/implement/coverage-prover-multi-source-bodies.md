description: Extend the covering-structure coverage prover (`proveCoverage` in `planner/analysis/coverage-prover.ts`) to admit a multi-source (join) materialized-view body as covering a single-table UNIQUE constraint, when the join provably contributes exactly one MV row per constrained-table row (1:1, no fan-out, no row loss).
prereq:
files: packages/quereus/src/planner/analysis/coverage-prover.ts, packages/quereus/test/covering-structure.spec.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/nodes/join-utils.ts, packages/quereus/src/planner/util/key-utils.ts, packages/quereus/src/planner/analysis/predicate-shape.ts, docs/materialized-views.md, docs/optimizer.md
----

## Goal

v1 `proveCoverage` rejects any body whose source is not a single linear chain to one
`TableReferenceNode` over the constrained table `T` (`relations.length !== 1` ⇒
`NotCovers('shape')`). This ticket teaches the prover to descend through **join**
nodes and accept a join body when each governed `T` row maps to **exactly one** MV
row — the precondition for the MV to be a faithful covering index for a `unique`
constraint on `T`.

Canonical admit case — `T` left-joined to a lookup table on a unique key, where the
lookup neither drops nor duplicates `T`'s rows:

```sql
create table orders (id integer primary key, customer_id integer not null, sku text not null, unique(customer_id, sku));
create table customers (id integer primary key, name text);
create materialized view ix as
  select o.customer_id, o.sku, o.id
  from orders o left join customers c on o.customer_id = c.id
  order by o.customer_id, o.sku;     -- should cover unique(customer_id, sku) on orders
```

## Soundness — the 1:1 decomposition

A false `Covers` is unsound (the lens layer would later miss conflicts); a false
`NotCovers` only forgoes an optimization. "Exactly one MV row per governed `T` row"
decomposes into two **independent** obligations, each proven by a distinct surface:

- **No fan-out (≤1 MV row per `T` row).** `T`'s primary key, mapped to the body
  output columns, must be a unique key of the body output relation `root`:
  `isUnique(pkOutputCols, root)` (from `planner/util/fd-utils.js`, already imported).
  The optimizer already propagates join key-preservation into `root.physical.fds`
  via `analyzeJoinKeyCoverage` → `propagateJoinFds` (`key-utils.ts` / `join-utils.ts`):
  for `T LEFT JOIN L on T.fk = L.ukey` it emits `T.pk → all_output_cols` **iff** the
  equi-pairs cover a unique key of `L` (`rightKeyCovered`), i.e. iff each `T` row
  matches ≤1 `L` row. So `isUnique(T.pk-on-output, root)` is **exactly** the
  no-fan-out test — it returns false the moment the lookup side can multiply a `T`
  row (`L.ukey` not unique ⇒ no preserved-key FD ⇒ `T.pk` not a superkey of `root`).

- **No row loss (≥1 MV row per `T` row).** FDs encode uniqueness, not existence, so
  this is **not** captured by `isUnique`. It is a structural property of the join
  type and `T`'s side: `T` must sit on the **preserving** side of every join between
  `root` and `T`'s `TableReferenceNode`:
    - `left` join with `T` in the **left** subtree → all `T` rows preserved (unmatched
      rows are NULL-padded on the lookup columns, but still present once),
    - `right` join with `T` in the **right** subtree → symmetric.
  `inner` / `cross` drop non-matching `T` rows (sound only with enforced referential
  integrity — deferred, see backlog), `semi` / `anti` filter `T` rows, `full` injects
  spurious lookup-only rows. All rejected ⇒ `NotCovers('shape')`.

Both obligations are required and neither implies the other:
- A `left` join with a **non-unique** lookup key is row-preserving but **fans out** —
  caught by the `isUnique` gate.
- An `inner` join to a unique lookup key is non-fanning but **loses** the unmatched
  `T` rows — caught by the structural side/type gate.

### Why this is NOT the `extractBindings` `'row'` classification

The ticket scope hypothesizes consulting the binding extractor's `'row'`
classification. That is the wrong signal and `binding-extractor.ts` needs **no
change**. `analyzeRowSpecific`'s `'row'` is *equality-pinned* — it fires only when
equality constraints (to literals/parameters) cover `T`'s key at the reference, and
reports a bare join scan as `'global'` (see the note in
`docs/materialized-views.md` § Incremental refresh). The sound realization of
"exactly one MV row per source row" is `T`'s primary key being **preserved as a key
of the body output** — the FD-surface fact (`isUnique` / `keysOf`) the prover's
sibling `proveEffectiveKeyUnique` already consumes. Document this reconciliation in
the module doc so the next reader does not chase the binding extractor.

## Composition with the v1 checks (all still apply, unchanged)

Once the shape walk reaches `T`'s `TableReferenceNode`, every v1 check runs exactly
as today against `tableRef` and `root` — they are already frame-correct for a join
body because the covering columns are all `T`'s:

- **Projection.** `root`'s output must include every UC column **and** every `T` PK
  column (mapped via stable attribute IDs; the lookup side's attributes simply are
  not in `baseAttrToCol` and are ignored). UC columns belong to `T` (the constraint
  is on `T`), so they resolve to `T` attributes.
- **Ordering.** Body `ORDER BY` (read from `mv.selectAst`, the faithful source) must
  be a permutation of the UC columns. **Implementation gotcha:** join-body `ORDER BY`
  terms are usually table-qualified (`o.customer_id`). `columnIndexFromExpr`
  (`predicate-shape.ts`) resolves `type: 'column'` by bare `name` (qualifier ignored)
  but **rejects** `type: 'identifier'` carrying a `schema`/qualifier. Verify which
  AST shape the parser emits for `alias.col` in an `ORDER BY` and that it resolves
  against `baseTable.columnIndexMap`; a qualified term that fails to resolve yields
  `ordering-mismatch` (sound, but would reject the canonical admit case). Extend
  resolution if needed (a focused test will surface this).
- **Predicate alignment.** The body `WHERE` (read from AST) is checked against the UC
  scope via `recognizeConjunctiveClauses(bodyWhere, baseTable)`, which is scoped to
  `baseTable` columns. A `WHERE` touching a lookup column is unrecognized ⇒ rejected
  (sound: such a predicate filters `T` rows by a non-`T` condition). The join `ON`
  condition lives in the AST `from` clause, **not** in `WHERE`, and a `left`/`right`
  outer `ON` never drops preserved-side rows — so it does not enter predicate
  alignment. (This is why outer-join-only matters: any `WHERE` that could null-reject
  the outer join references the lookup side and is already rejected.)

## Plan-walk design

Branch the existing shape walk in `proveCoverage` (currently rejects any
`relations.length !== 1`) to handle binary join nodes. Keep the walk plan-based and
conservative — consistent with v1's hybrid (shape from plan; ordering + WHERE from
AST):

```
walk node from root:
  TableReferenceNode      → must be T (schema+name match) ⇒ this is the constrained source; stop.
  Filter / PASS_THROUGH   → exactly one relation ⇒ descend (unchanged v1 behavior).
  binary join node        → (PlanNodeType.Join | NestedLoopJoin | HashJoin | MergeJoin)
                            read joinType, left, right.
                            leftHasT  = subtree(left)  contains T's TableReferenceNode
                            rightHasT = subtree(right) contains T's TableReferenceNode
                            leftHasT === rightHasT      ⇒ NotCovers('shape')   // ambiguous / self-join / neither
                            leftHasT  && joinType!=='left'  ⇒ NotCovers('shape')
                            rightHasT && joinType!=='right' ⇒ NotCovers('shape')
                            descend into T's side.
  FanOutLookupJoin / AsofScan / anything else ⇒ NotCovers('shape').
```

After the walk binds `tableRef` and runs the v1 projection/ordering/predicate checks,
add the **fan-out gate**: build `pkOutputCols` (each `T` PK column → its `root` output
index, via the same attribute-ID map used for projection coverage; all are present
because the `missing-pk-column` check already passed), then require
`isUnique(pkOutputCols, root)` — else `NotCovers('fanout')`.

Note: when the optimizer **eliminates** a key-preserving lookup join (lookup columns
unprojected, key-preservation provable) the body collapses to a single-source chain
and v1 already covers it with no new code. This ticket handles the residual cases
where the join survives the optimizer but is still provably 1:1.

## Out of scope (parked)

- **Inner/cross-join covering via enforced referential integrity** — an inner lookup
  join is 1:1 when every `T` row provably matches (NOT NULL FK + referential
  integrity). Needs an FK-alignment + NOT-NULL proof (`checkFkPkAlignment` in
  `key-utils.ts` is the seam). Filed: `tickets/backlog/coverage-prover-inner-join-fk-preservation.md`.
- **Full-outer covering** — would require discarding the spurious lookup-only
  (NULL-`T`) rows; not worth the complexity now. Rejected as `shape`.

## TODO

Phase 1 — prover

- [ ] Add `'fanout'` to `CoverageFailureReason` (and the module doc's reason list).
- [ ] Add a `subtreeContainsConstrainedTable(node, baseTable)` helper (walk
      `getRelations()` for a `TableReferenceNode` matching `baseTable` by lowercased
      schema+name).
- [ ] In `proveCoverage`'s shape walk, branch on the four binary-join `PlanNodeType`s
      (`Join`, `NestedLoopJoin`, `HashJoin`, `MergeJoin`): determine `T`'s side, reject
      ambiguous/self-join (T on both or neither), reject when `T` is not on the
      preserving side (`left`→left, `right`→right; all other join types rejected),
      then descend into `T`'s side. Reject `FanOutLookupJoin`/`AsofScan` explicitly.
- [ ] While building projection coverage, also build `baseCol → rootOutputIndex`, then
      after the projection/PK checks compute `pkOutputCols` and gate on
      `isUnique(pkOutputCols, root)` ⇒ `NotCovers('fanout')` on failure.
- [ ] Verify join-body `ORDER BY` term resolution: confirm `columnIndexFromExpr`
      resolves `alias.col` against `baseTable.columnIndexMap`; if the parser emits a
      qualified `identifier` (rejected today), extend the ordering resolution to strip
      a table qualifier when the bare name resolves to a `baseTable` column. Do NOT
      loosen `columnIndexFromExpr`'s existing schema-qualified rejection for its other
      callers — handle qualifier-stripping locally in the ordering path if needed.
- [ ] Rewrite the module doc's "Narrow v1" paragraph to describe the multi-source
      admit path + the 1:1 decomposition + the `extractBindings` reconciliation.

Phase 2 — tests (`covering-structure.spec.ts`, mirroring the existing `prove` helper)

- [ ] **Positive:** `orders left join customers on orders.customer_id = customers.id`,
      projecting `customer_id, sku, id` ordered by `customer_id, sku`, covers
      `unique(customer_id, sku)` on `orders` (the canonical case above). Assert
      `.covers === true`.
- [ ] **Positive:** same with the lookup on the **right** of a `right join` (symmetry).
- [ ] **Negative `fanout`:** left join to a lookup table on a **non-unique** column
      (no PK / no unique on the join key) ⇒ `{ covers:false, reason:'fanout' }` — the
      lookup multiplies `T` rows.
- [ ] **Negative `shape`:** the same body as an **inner** join ⇒ `reason:'shape'`
      (row loss not provable). Guards the soundness boundary.
- [ ] **Negative `shape`:** `T` on the **dropping** side of an outer join
      (`lookup left join T`) ⇒ `reason:'shape'`.
- [ ] **Negative `shape`:** self-join of `T` to `T` ⇒ `reason:'shape'` (ambiguous).
- [ ] **Negative:** `WHERE` referencing a lookup column ⇒ rejected
      (`predicate-entailment` / `missing-null-skip`), confirming a non-`T` filter
      cannot sneak through.
- [ ] **Regression:** existing single-source positive/negative cases still pass
      unchanged.
- [ ] Confirm the eager link path is exercised end-to-end: a covering join MV stamps
      `mv.covers` / `uc.coveringStructureName` (via `linkCoveredUniqueConstraints`),
      and a `fanout`/`shape` join MV stamps nothing.

Phase 3 — docs & validation

- [ ] Update `docs/materialized-views.md` § Covering structures (recognition rules:
      add the join admit path + the two-obligation soundness note; update the deferred
      follow-ups list — this ticket lands, inner-join-FK becomes the new deferral).
- [ ] Update `docs/optimizer.md` § Coverage proving if it enumerates the shape rules.
- [ ] `yarn workspace @quereus/quereus run build`, the covering-structure spec
      (`yarn workspace @quereus/quereus test 2>&1 | tee /tmp/cov.log; tail -n 60 /tmp/cov.log`),
      and `yarn workspace @quereus/quereus lint` (single-quote globs on Windows).
