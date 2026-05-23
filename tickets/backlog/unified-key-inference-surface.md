description: Consolidate the three uniqueness surfaces (RelationType.keys, PhysicalProperties.fds, RelationType.isSet) behind a single keysOf()/isUnique() read API, and add a key-soundness property harness so inference is provably sound across all relational operators. Closes the gap where a DISTINCT's all-columns key (carried only by isSet) is invisible to FD-consuming rules.
files: packages/quereus/src/common/datatype.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/nodes/distinct-node.ts, packages/quereus/src/planner/nodes/set-operation-node.ts, packages/quereus/src/planner/nodes/aggregate-node.ts, packages/quereus/src/planner/nodes/project-node.ts, packages/quereus/src/planner/nodes/join-utils.ts, packages/quereus/src/planner/rules/distinct/rule-distinct-elimination.ts, packages/quereus/src/planner/rules/join/rule-join-elimination.ts, packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts, packages/quereus/src/planner/rules/subquery/rule-semi-join-fk-trivial.ts, packages/quereus/src/planner/rules/aggregate/rule-groupby-fd-simplification.ts, packages/quereus/src/planner/rules/sort/rule-orderby-fd-pruning.ts, packages/quereus/test/property.spec.ts, docs/optimizer.md, docs/architecture.md
----

## Background

Quereus tracks "what is unique on a relation's output" across **three** surfaces:

- `RelationType.keys: ColRef[][]` — declared/logical superkeys. The empty key `[]` already carries a special meaning: "0 or 1 rows" (`TableDee`/`TableDum`).
- `PhysicalProperties.fds` — functional dependencies. A unique key `K` is encoded as `K → (all_cols \ K)`; the singleton `∅ → all_cols` encodes "at-most-one-row".
- `RelationType.isSet: boolean` — "no duplicate rows", i.e. the **all-columns** key.

The all-columns key is structurally un-encodable as an FD: `K → (all_cols \ K)` with `K = all_cols` has empty dependents, which is the tautology `X → ∅` that holds for bags too (FDs describe inter-column determinism; set-ness is row multiplicity). `superkeyToFd` deliberately returns `undefined` for that case, so the fact lives only on `isSet`.

### The gap

FD-consuming optimizer rules read `fds`/`keys` but **not** `isSet`, so the all-columns key a `select distinct x, y` proves is invisible to them. Audited consumers that miss it today:

- `rule-distinct-elimination` — checks `sourceType.keys` and `fds`, not `isSet`; a redundant outer DISTINCT over a set source is not eliminated.
- `rule-groupby-fd-simplification` — cannot drop a GROUP BY that spans all output columns of a set source.
- `rule-orderby-fd-pruning` — cannot prune trailing ORDER BY keys that cover a set's full tuple.
- `rule-join-elimination`, `rule-fanout-lookup-join`, `rule-semi-join-fk-trivial` — only consult declared FK→PK alignment; they never see `isSet`.

The practical optimization upside is **narrow** by nature: the all-columns key is the weakest possible key, so it only helps an operation that references *every* output column (e.g. equi-join on all columns, GROUP BY on all columns). It is genuinely real for nested/redundant DISTINCT and all-column GROUP BY/ORDER BY shapes. (Note: an all-columns key does **not** make a single-column equi-join "at most one match" — that proof needs the join key to be a superkey, which the all-columns key only satisfies when the join covers all columns. Any "bridge" must preserve that.)

### Why isSet is not redundant fat

A clean equivalence: **a relation has ≥1 unique key ⟺ it is a set** (any unique key ⇒ no two rows identical ⇒ set; conversely a set always has the all-columns key as trivial witness). So set-ness *is* "the key set is non-empty," and `isSet`'s irreducible content is the all-columns-key fact when no smaller key exists. That bit must be stored somewhere — `isSet` (boolean) or a materialized all-columns entry in `keys` (a `ColRef[]` listing every column). The boolean is cheaper for this particular key: it propagates as a one-line copy through projection/window/etc., whereas a materialized all-columns list is schema-relative, redundant with `columns`, and must be re-derived (and re-validated against dropped columns) at every column-reshaping node. A sentinel "all-columns" entry inside `keys` is just `isSet` relocated, not a reduction in moving parts.

`isSet` usage was audited: ~1 write (`best-access-plan.ts setIsSet`, ≤1-row access paths) and ~17 reads, all either whole-propagation (`isSet: sourceType.isSet`) or AND-combination across inputs (joins `left && right`; `AsyncGatherNode.crossProduct` `every`; set-ops/recursive-CTE keyed off `unionAll`). **No subset/partial reasoning, and zero reads in `runtime/` or `emit/`** — it is purely a planning-time signal.

## What needs to happen

### 1. A single read surface for keys

Provide two helpers (likely in `fd-utils.ts`) that reconcile all three surfaces so callers stop caring which one a fact lives on:

```ts
// Canonical set of minimal candidate keys, normalized & deduped.
// Empty result ⟺ relation is a bag. Always includes the all-columns
// key as fallback when the relation is a set but no smaller key was found.
keysOf(rel: { getType(): RelationType; physical?: PhysicalProperties }): readonly (readonly number[])[];

// Is `cols` a superkey? Uses FD closure (an FD can prove a superkey
// not present in the minimal key list), the declared keys, and the
// all-columns/set fact.
isUnique(cols: readonly number[], rel): boolean;
```

`keysOf` draws minimal keys from: declared `keys` (incl. empty key = ≤1 row), FD determinants whose closure covers all columns, and the all-columns fallback when the set-bit is true. **Bound required:** minimal-key derivation from a general FD set is the candidate-key enumeration problem (NP-hard in column count). Document and enforce a cap (e.g. always emit declared keys + all-columns fallback; bound FD-derived enumeration by column/seed count) so it cannot blow up; over-capping costs only completeness, never soundness.

This surface deliberately hides the `isSet`-vs-materialized-key representation decision (see below), so consumers are migrated once and the representation can change later without touching them.

### 2. Migrate consumers

Route the audited `isUnique`/`hasAnyKey`/`hasSingletonFd`/`isSuperkey` callers (distinct-elimination, groupby-fd-simplification, orderby-fd-pruning, and the join/semi-join uniqueness proofs) and the `isSet` reads through the new helpers. The join/fan-out/semi-join "at-most-one-match" proofs must keep their FK→PK semantics and only additionally recognize an all-columns key where the matching predicate actually covers all columns.

### 3. Soundness validation harness (the confidence mechanism)

"100% accuracy" splits into two properties that must not be conflated:

- **Soundness** (never claim a key that does not hold) — a **correctness** invariant. An over-claimed key makes DISTINCT/join elimination drop real rows. This must be 100%.
- **Completeness** (never miss a real key) — an **optimization** nicety. NP-hard / data-dependent in general; best-effort only. So "100% accuracy" can only mean **100% soundness + best-effort completeness**.

Add a `fast-check`-style key-soundness property to `test/property.spec.ts`: generate plans over random data, materialize each relational node's output, and assert that (a) every key reported by `keysOf` actually has distinct values across the produced rows, and (b) every `isSet`/set-bit relation actually has no duplicate rows. This empirically guards per-operator propagation across the whole node zoo, which spot tests cannot.

### 4. Per-operator propagation audit

Confirm each node's `computePhysical`/`getType` emits only sound keys/FDs given its children. Highest-risk cases: **projection must drop any key/FD referencing a projected-away column** (the place a careless all-columns key goes unsound), and **at-most-one-row (empty key / `∅ → all_cols`) must imply set-ness consistently** (today `keys` containing `[]` does not reliably set `isSet`).

## Representation decision (defer behind keysOf, or fold in)

Whether `isSet` stays as the carrier or is replaced by a materialized all-columns key in `RelationType.keys` is a representational preference, not a reduction in concepts. **Default for this ticket: keep `isSet`, deliver `keysOf`/`isUnique`, defer the representation change** — the new read surface makes it a non-breaking follow-up. Promote a separate ticket if the team later wants `isSet` removed from the type for purity reasons.

## Acceptance criteria

- `keysOf` and `isUnique` exist, are documented, and are the single uniqueness read path for the migrated consumers; `keysOf` has a documented enumeration bound.
- `select distinct x, y` over `(select distinct x, y …)` eliminates the redundant outer DISTINCT; an all-output-column GROUP BY / ORDER BY over a set source is simplified/pruned.
- Join/fan-out/semi-join "at-most-one" proofs still require the matching predicate to cover a real superkey — no false at-most-one from the weak all-columns key.
- The key-soundness property harness passes and fails loudly if any operator over-claims a key or set-ness on generated data.
- Projection drops keys/FDs over projected-away columns; at-most-one-row implies set consistently.
- `docs/optimizer.md` (Functional Dependency Tracking) and `docs/architecture.md` reflect the unified surface and the soundness-vs-completeness distinction.
