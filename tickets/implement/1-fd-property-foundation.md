---
description: First-class functional-dependency property on relational plan nodes — data structure, propagation lattice, and closure-on-demand utility (no consumers yet)
files:
  - packages/quereus/src/planner/nodes/plan-node.ts
  - packages/quereus/src/planner/util/key-utils.ts
  - packages/quereus/src/planner/util/fd-utils.ts (new)
  - packages/quereus/src/planner/nodes/reference.ts
  - packages/quereus/src/planner/nodes/filter.ts
  - packages/quereus/src/planner/nodes/project-node.ts
  - packages/quereus/src/planner/nodes/returning-node.ts
  - packages/quereus/src/planner/nodes/distinct-node.ts
  - packages/quereus/src/planner/nodes/stream-aggregate.ts
  - packages/quereus/src/planner/nodes/hash-aggregate.ts
  - packages/quereus/src/planner/nodes/aggregate-node.ts
  - packages/quereus/src/planner/nodes/join-node.ts
  - packages/quereus/src/planner/nodes/bloom-join-node.ts
  - packages/quereus/src/planner/nodes/merge-join-node.ts
  - packages/quereus/src/planner/nodes/set-operation-node.ts
  - packages/quereus/src/planner/nodes/window-node.ts
  - packages/quereus/src/planner/nodes/asof-scan-node.ts
  - packages/quereus/src/planner/nodes/alias-node.ts
  - packages/quereus/src/planner/framework/physical-utils.ts
  - packages/quereus/test/optimizer/fd-propagation.spec.ts (new)
  - docs/architecture.md
  - docs/optimizer.md
---

## Goal

Land the functional-dependency (FD) **foundation** — types, per-operator propagation, equivalence-class tracking, and an on-demand closure helper — with **no consumers yet**. Existing `uniqueKeys` consumers (`rule-distinct-elimination`, `analyzeJoinKeyCoverage`, `CatalogStatsProvider.joinSelectivity`, change-detection classification) MUST continue to work unchanged. The follow-up tickets enumerated in the plan ticket are out of scope here.

## Data shape

Extend `PhysicalProperties` (in `packages/quereus/src/planner/nodes/plan-node.ts` near the existing `uniqueKeys` field) with two new **optional** fields:

```typescript
export interface FunctionalDependency {
  /** Determinant column indices in the node's output. Empty array means "constant" (no row variation). */
  readonly determinants: readonly number[];
  /** Dependent column indices in the node's output. Non-empty. */
  readonly dependents: readonly number[];
}

export interface PhysicalProperties {
  // ... existing fields ...

  /**
   * Functional dependencies that hold over the output stream. Superkeys
   * (entries in `uniqueKeys`) imply the FD `key → all-columns`; `fds` carries
   * the additional, non-key dependencies. The set is non-canonical — only
   * the explicit FDs each operator can prove are stored. Use
   * `computeClosure(attrs, fds)` to derive what a set of attributes implies.
   */
  fds?: ReadonlyArray<FunctionalDependency>;

  /**
   * Equivalence classes over the node's output columns. Each class is a set
   * of column indices known to hold equal values for every row. Derived from
   * equality predicates and equi-join conditions.
   */
  equivClasses?: ReadonlyArray<ReadonlyArray<number>>;
}
```

Notes:
- `uniqueKeys` stays as-is. Do **not** dual-write FDs that duplicate the all-columns-from-key relationship; consumers can call `superkeyToFd(key, columnCount)` on demand if they want a unified view (provide the helper but don't materialize).
- Column indices in `fds` / `equivClasses` are output-column indices of the node, consistent with how `uniqueKeys` is indexed today.
- Both fields default to `undefined` (treated as "no information"). Empty arrays are valid and distinct from undefined only for callers that care about the distinction; prefer `undefined` when there's nothing to add.

## Closure & helper utilities

Create `packages/quereus/src/planner/util/fd-utils.ts` exporting:

```typescript
import type { FunctionalDependency } from '../nodes/plan-node.js';

/** Closure of `attrs` under `fds`. O(|fds| * |attrs|) — iterative fixed-point. */
export function computeClosure(attrs: ReadonlySet<number>, fds: ReadonlyArray<FunctionalDependency>): Set<number>;

/** True iff `attrs` determines every attribute in `target` under `fds`. */
export function determines(attrs: ReadonlySet<number>, target: ReadonlySet<number>, fds: ReadonlyArray<FunctionalDependency>): boolean;

/** Smallest subset of `attrs` whose closure equals the closure of `attrs`. Greedy minimization. */
export function minimalCover(attrs: ReadonlySet<number>, fds: ReadonlyArray<FunctionalDependency>): Set<number>;

/** Merge two FD lists, dropping redundant entries (same determinants, dependent subset). Used by join propagation. */
export function mergeFds(a: ReadonlyArray<FunctionalDependency>, b: ReadonlyArray<FunctionalDependency>): FunctionalDependency[];

/** Add a single FD, dropping any existing FD with the same determinants whose dependents are a subset of the new one. */
export function addFd(fds: ReadonlyArray<FunctionalDependency>, next: FunctionalDependency): FunctionalDependency[];

/** Project FDs through a column mapping (oldCol -> newCol). FDs whose determinants OR dependents lose any column are dropped. */
export function projectFds(fds: ReadonlyArray<FunctionalDependency>, mapping: ReadonlyMap<number, number>): FunctionalDependency[];

/** Shift all column indices by `offset`. Used by join propagation for the right input's FDs and equivClasses. */
export function shiftFds(fds: ReadonlyArray<FunctionalDependency>, offset: number): FunctionalDependency[];
export function shiftEquivClasses(classes: ReadonlyArray<ReadonlyArray<number>>, offset: number): number[][];

/** Merge two equivalence-class sets, taking the transitive closure of overlapping classes. */
export function mergeEquivClasses(a: ReadonlyArray<ReadonlyArray<number>>, b: ReadonlyArray<ReadonlyArray<number>>): number[][];

/** Add a new equality `a ≡ b` to an existing class list, performing the union-find merge. */
export function addEquivalence(classes: ReadonlyArray<ReadonlyArray<number>>, a: number, b: number): number[][];

/** Build an FD `key → {0..columnCount-1} \ key` from a superkey. Helper for consumers that want a unified view. */
export function superkeyToFd(key: readonly number[], columnCount: number): FunctionalDependency;
```

Implementation tips:
- `computeClosure` uses the standard fixed-point: start with `attrs`; repeatedly scan `fds` for any FD whose determinants are all in the closure and add its dependents; stop when no growth.
- `addFd` is the per-operator de-dup point. If `fds.length` exceeds `tuning.maxFdsPerNode` (default 64 — add to existing tuning config if there is one, else inline a const), drop FDs whose determinants are not a subset of any `uniqueKeys` entry or equivalence-class representative. Log via the standard `createLogger('quereus:planner:fd')` channel at debug level when truncation occurs.
- Equivalence classes are stored as arrays of indices (sorted ascending) — keep them small (most plans have ≤ a few classes).

## Per-operator propagation rules

Implement `computePhysical` updates on each operator below. For every operator: source FDs/ECs come from `childrenPhysical[i]?.fds` / `equivClasses` (already in the node's coordinate space for unary ops, shifted for joins). After deriving the per-op delta, call `addFd` / `mergeEquivClasses` and assign to the result.

### `TableReferenceNode` (`reference.ts`)
- Seed FDs from declared keys: for each `RelationType.keys` entry, emit `key → all-other-columns`. (This duplicates information already in `uniqueKeys`; deferred consumers benefit from having it as an explicit FD too. Tag the implementation with a comment that the duplication is intentional.)
- No equivalence classes at the leaf.

### `FilterNode` (`filter.ts`)
- Inherit child `fds` and `equivClasses`.
- Walk the predicate (use the same predicate-conjunct decomposition logic already used by `extractPredicateConjuncts` / equivalent — search `planner/analysis/predicate-*` for the helper):
  - `col = literal` (literal must be a constant `ScalarPlanNode`, no parameters/subqueries): add FD `∅ → col`. Also merge into a "constant" equivalence class — actually skip the EC here; constants don't go in ECs (they are determined by the `∅ → c` FD).
  - `col1 = col2` (both are bare column refs to the filter's output): add FDs `{col1} → {col2}` and `{col2} → {col1}`, plus `addEquivalence(equivClasses, col1, col2)`.
- Ignore non-equality predicates for FD purposes. Wrap the predicate walk in a helper `extractEqualityFds(predicate, attributes)` inside `fd-utils.ts` or a sibling module — keep it small and unit-testable.

### `ProjectNode` (`project-node.ts`) and `ReturningNode` (`returning-node.ts`)
- Build the column mapping from output column → source column **only when** the projection element is a bare column reference (`ColumnReferenceNode`). For non-trivial expressions, leave that output column out of the mapping (it falls out of any propagated FD).
- Call `projectFds(sourceFds, mapping)`; assign to `fds`.
- For `equivClasses`: project each class through the mapping; drop classes that collapse to <2 members.
- (Injective-expression extension is out of scope here — comment marker for the follow-up ticket.)

### `AliasNode` (`alias-node.ts`)
- Pass `fds` and `equivClasses` through unchanged (attribute IDs and column count don't change).

### `DistinctNode` (`distinct-node.ts`)
- Pass `fds` and `equivClasses` through unchanged. The new all-columns key already lives in `uniqueKeys`.

### `StreamAggregateNode`, `HashAggregateNode`, `AggregateNode` (`stream-aggregate.ts`, `hash-aggregate.ts`, `aggregate-node.ts`)
- The existing GROUP-BY → `uniqueKeys` rule is already there; do not change it.
- For source FDs `X → Y`: keep the FD on the output iff `X ⊆ groupBy` (output indices 0..groupCount-1) **and** `Y` columns survive the projection to output columns. Restrict `Y` to surviving columns. Use the same column-mapping infrastructure used for `uniqueKeys` propagation (or reuse `projectFds`).
- Equivalence classes: keep only classes whose members are all among the GROUP BY columns, projected to their output indices.

### `JoinNode` (`join-node.ts`) — logical
- Logical join generally doesn't compute physical, but if it does (some logical nodes do for cost), follow the inner-join rule below.

### `BloomJoinNode`, `MergeJoinNode` (`bloom-join-node.ts`, `merge-join-node.ts`)
- Inner / Cross: `union(leftFds, shiftFds(rightFds, leftAttrs.length))`. For each equi-pair `(L, R')` (with `R' = R + leftAttrs.length`): add FDs `{L} → {R'}` and `{R'} → {L}`, plus `addEquivalence(merged, L, R')`.
- LEFT outer: keep left's FDs on left's columns only; drop right's FDs (NULL-padded rows can violate them). Equi-pair FDs/ECs are **not** added — the equality is not guaranteed on padded rows.
- RIGHT outer: mirror of LEFT.
- FULL outer: drop both sides' FDs. (Conservative; refined in a follow-up.)
- SEMI / ANTI: left's FDs survive on left's columns; no right contribution. (BloomJoinNode currently does not have semi/anti, but follow the rule if it grows them.)

### `AsofScanNode` (`asof-scan-node.ts`)
- Inherit left's FDs on left's columns. Drop right's FDs (asof = at-most-one match; NULL-padded when no match in `outer` mode). Do **not** emit equi-pair FDs — the asof match isn't an equality.

### `SetOperationNode` (`set-operation-node.ts`)
- `UNION ALL` / `EXCEPT ALL`: no FDs, no ECs (conservative).
- `UNION` / `INTERSECT` (set semantics): only the all-columns FD (already captured by `uniqueKeys`), no per-column FDs.

### `WindowNode` (`window-node.ts`)
- Inherit source FDs and ECs. Output window-function columns are not in any new FDs (deferred).

## Safety valve

Add a `MAX_FDS_PER_NODE` const (default 64) in `fd-utils.ts`. `mergeFds` / `addFd` enforce it by dropping FDs whose determinants are not a subset of any `uniqueKeys` entry on the same node (the caller passes `uniqueKeys` to `addFd` when capping — keep the signature pragmatic: `addFd(fds, next, opts?: { uniqueKeys?: number[][]; cap?: number })`). Log truncation at debug.

## Tests

Create `packages/quereus/test/optimizer/fd-propagation.spec.ts` with one `describe` per operator. For each:
- Build a plan whose output exposes a `physical` property (use the existing test scaffolding from `keys-propagation.spec.ts` and `ordering-propagation.spec.ts` — they show how to optimize a parsed statement and inspect physical properties).
- Assert the expected `fds` and `equivClasses` shapes.

Cases to cover (one test each unless noted):
- **TableReference**: PK ⇒ FD `pk → others`; second UNIQUE ⇒ another FD entry.
- **Filter**: `col = 5` ⇒ `∅ → col`; `a = b` ⇒ two FDs + one EC of `{a, b}`; non-equality (e.g. `col > 5`) ⇒ no new FDs/ECs; mixed conjunction ⇒ both contributions.
- **Project**: bare column projection survives; expression projection drops the column from FDs.
- **Alias**: pass-through.
- **Distinct**: pass-through plus existing all-columns key.
- **StreamAggregate / HashAggregate**: GROUP BY a, b — source FD `a → c` survives only when `c` is in the output AND `a` is in GROUP BY (it is). Drop a FD whose determinant column is not in GROUP BY.
- **BloomJoin inner**: equi-pair adds bi-directional FDs and merges classes; left and right FDs are present (right's column indices shifted).
- **BloomJoin LEFT outer**: only left's FDs survive; no equi-pair FDs.
- **MergeJoin inner**: same as bloom inner.
- **SetOperation UNION ALL**: no FDs.
- **Window**: source FDs pass through unchanged.

Also add unit tests in the same file for `fd-utils.ts`:
- `computeClosure({a}, [{a→b}, {b→c}])` ⇒ `{a, b, c}`.
- `determines` smoke tests for trivial and transitive cases.
- `minimalCover` removes redundant attributes.
- `mergeEquivClasses` correctly unions overlapping classes (`[[1,2], [2,3]]` ⇒ `[[1,2,3]]`).
- `addEquivalence` merges existing classes.
- `projectFds` drops FDs that lose any determinant or dependent column.
- `addFd` dedupes when the new FD subsumes existing ones.

## Documentation

- `docs/architecture.md` — under "Key Design Decisions", add a one-paragraph mention that the engine tracks functional dependencies (not just superkeys) on every relational physical node, with a link to `docs/optimizer.md` for details.
- `docs/optimizer.md` — add a new top-level section **"Functional Dependency Tracking"** before or near the existing "Key-driven row-count reduction" subsection (~line 1088). Cover: data shape (`fds`, `equivClasses`, `FunctionalDependency`), the propagation table from the plan ticket (one row per operator), the `fd-utils` helper surface, the de-dup / cap behavior, and a note that consumers are forthcoming. Update the "Key-driven row-count reduction" subsection to cross-reference the new FD framework. Add `fds` and `equivClasses` to the `PhysicalProperties` interface listing if it appears.

## Out of scope (explicitly deferred — follow-up tickets in the plan ticket)

- Migration of `uniqueKeys` consumers to read `fds`.
- Injective-expression projection FDs.
- FK→PK derived FDs on the child side of a join.
- Outer-join key-preservation refinements beyond the conservative rule above.
- All "consumer" tickets enumerated in the plan ticket (groupby simplification, orderby pruning, join elimination, predicate inference through ECs, change-detection FD classification, view maintenance with FD binding keys).

## TODO

### Phase 1 — Types and helpers
- Add `FunctionalDependency` interface and `fds`, `equivClasses` fields to `PhysicalProperties` in `packages/quereus/src/planner/nodes/plan-node.ts`.
- Create `packages/quereus/src/planner/util/fd-utils.ts` with the eight exported functions listed above, the `MAX_FDS_PER_NODE` cap, and the `extractEqualityFds(predicate, attributes)` predicate-walker (consider placing the predicate walker in a separate file if it gets large or already has a natural home in `planner/analysis/`).
- Add unit tests for every `fd-utils` export in `packages/quereus/test/optimizer/fd-propagation.spec.ts`.

### Phase 2 — Propagation
- Update `computePhysical` in each operator listed above. Keep edits minimal and local; preserve existing `uniqueKeys` / `ordering` / `monotonicOn` logic exactly. Use `?? undefined` / spread merges so that operators with no FD contribution keep returning the same shape they do today.
- For each operator update, immediately add the corresponding test case in `fd-propagation.spec.ts`. Use the existing `keys-propagation.spec.ts` and `ordering-propagation.spec.ts` patterns (parse → optimize → inspect physical).

### Phase 3 — Build/test gate
- `yarn workspace @quereus/quereus run build` clean.
- `yarn workspace @quereus/quereus run lint` clean (lint runs only on the quereus package).
- `yarn test` (the standard fast suite) passes — no regression in `keys-propagation`, `ordering-propagation`, `rule-distinct-elimination`, or any existing optimizer/logic test.
- Skip `yarn test:store` — this ticket adds physical-property metadata only; no execution-path changes.

### Phase 4 — Docs
- Update `docs/architecture.md` (one paragraph under Key Design Decisions).
- Update `docs/optimizer.md` (new "Functional Dependency Tracking" section + cross-reference fix on the existing key-driven subsection).
