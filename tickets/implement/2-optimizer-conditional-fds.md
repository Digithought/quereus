---
description: Add predicate-gated (conditional) functional dependencies to the FD/EC framework so discriminated-union and soft-delete schemas can express dependencies like `{status='active'} → region`. Filter activates a guarded FD when its predicate implies the guard.
files:
  - packages/quereus/src/planner/nodes/plan-node.ts
  - packages/quereus/src/planner/util/fd-utils.ts
  - packages/quereus/src/planner/analysis/check-extraction.ts
  - packages/quereus/src/planner/nodes/filter.ts
  - packages/quereus/src/planner/nodes/join-utils.ts
  - packages/quereus/src/planner/nodes/project-node.ts
  - packages/quereus/src/planner/nodes/aggregate-node.ts
  - packages/quereus/src/planner/nodes/stream-aggregate.ts
  - packages/quereus/src/planner/nodes/hash-aggregate.ts
  - packages/quereus/src/planner/nodes/reference.ts
  - packages/quereus/test/optimizer/conditional-fds.spec.ts
  - docs/optimizer.md
---

## Goal

Extend the FD/EC plumbing landed by `1-optimizer-check-derived-fds-and-domains` (now in `complete/`) so a `FunctionalDependency` can carry an optional **guard predicate**. A guarded FD `K → D` is active only when the surrounding predicate implies the guard. When a `FilterNode`'s predicate entails the guard, the FD's `guard` is stripped at that node — downstream operators see it as an ordinary unconditional FD.

The CHECK extraction work just landed already recognizes equality / inequality / BETWEEN / IN shapes at top-level conjunctions. This ticket extends the extractor to recognize **implication-form** CHECKs and threads guards through propagation.

## Architecture

### Extended `FunctionalDependency`

Augment the type in `packages/quereus/src/planner/nodes/plan-node.ts`:

```ts
export interface FunctionalDependency {
  readonly determinants: readonly number[];
  readonly dependents: readonly number[];
  /** When defined, the FD only activates if a surrounding predicate entails every clause. */
  readonly guard?: GuardPredicate;
}

export interface GuardPredicate {
  /** Conjunction — all clauses must be entailed for activation. */
  readonly clauses: readonly GuardClause[];
}

export type GuardClause =
  | { readonly kind: 'eq-literal'; readonly column: number; readonly value: SqlValue }
  | { readonly kind: 'eq-column'; readonly left: number; readonly right: number }
  | { readonly kind: 'is-null'; readonly column: number; readonly negated: boolean };
```

This is deliberately narrow — equality / is-null / not-is-null. More expressive guards (inequality, IN-list) are deferred. Updates to existing helpers must treat the `guard` field uniformly:

- `fdsEqual` / `determinantsEqual`: structural equality must include guard equality (two FDs with the same `K → D` but different guards are different FDs).
- `computeClosure`: **never** consume a guarded FD. The closure tracks unconditional implication; activation is the Filter's job. Add a guard-stripping pass at the Filter boundary instead.
- `mergeFds` / `addFd`: subsumption stays guard-aware — only collapse FDs that share the same guard (or both-unconditional).
- `projectFds`: drop a guarded FD whose guard references any column not in the output mapping (the guard becomes unobservable, so the FD can never be re-activated downstream). Survives only if both the determinants/dependents *and* every column named in `guard.clauses` are in the mapping.
- `shiftFds`: shift guard column indices alongside determinants/dependents.

### Implication checker

New helper in `packages/quereus/src/planner/util/fd-utils.ts`:

```ts
export function predicateImpliesGuard(
  predicate: ScalarPlanNode,
  guard: GuardPredicate,
  ecs: ReadonlyArray<ReadonlyArray<number>>,
  bindings: ReadonlyArray<ConstantBinding>,
  attrIdToIndex: ReadonlyMap<number, number>,
  isColumnNonNullable: (col: number) => boolean,
): boolean;
```

Algorithm (conservative — when in doubt, return `false`):

1. Walk `predicate` as a conjunction. Pull every conjunct into a flat list. (Reuse the `extractEqualityFds` walking pattern but record raw conjuncts including `is null` and `is not null`.)
2. Build a fast lookup over conjuncts: a column-to-literal map (from `col = literal`), a column-equality set (from `col1 = col2`), an "is null" set, and a "not null" set.
3. For each guard clause, check entailment:
   - `eq-literal {column: c, value: v}`: matched if any conjunct says `c = v`, or `c'` in `c`'s EC has a constant binding equal to `v`, or `bindings` already pins `c` to `v`.
   - `eq-column {left: a, right: b}`: matched if `a` and `b` are in the same EC, or any conjunct equates them, or both share an identical constant binding (literal or same parameter ref).
   - `is-null {column: c, negated: false}`: matched if any conjunct is `c is null`.
   - `is-null {column: c, negated: true}` (i.e. `not null` guard): matched if any conjunct is `c is not null`, or `isColumnNonNullable(c)` returns true.
4. All clauses must match; otherwise `false`.

Note: ECs and constant bindings already carry forward predicate information at the Filter's child boundary, so this helper consults them rather than re-deriving from the predicate. The predicate walk only needs to discover **new** facts not yet folded in (e.g., `is null` clauses, which never make it into the EC/binding layer).

### Activation at `FilterNode`

In `FilterNode.computePhysical` (`packages/quereus/src/planner/nodes/filter.ts`):

1. Before extracting predicate-derived FDs, walk the inherited `sourcePhysical.fds`. For each guarded FD, run `predicateImpliesGuard(this.predicate, fd.guard, mergedEcs, mergedBindings, ...)`. **`mergedEcs` / `mergedBindings`** here means: the source's ECs/bindings **plus** what the current predicate adds — same merge that already happens further down in this method. Restructure so the merge happens once, up front, then activation, then continue.
2. If true, emit `{determinants, dependents}` without the `guard` (replace the original).
3. If false, pass through unchanged.
4. Continue with existing logic (`extractEqualityFds`, key-cover singleton, etc.).

`isColumnNonNullable` is sourced from `this.source.getAttributes()[col].type.nullable === false`.

### Propagation through other operators

- **Inner / cross join** (`join-utils.ts` `propagateJoinFds`): guarded FDs from each side survive (with shifted column indices on the right side, including their guard columns). The join's equi-pairs already extend the EC list — that may activate a guarded FD on a subsequent Filter. We do **not** run activation inside the join itself; the next predicate-bearing node handles it.
- **Outer joins**: drop guarded FDs whose dependents (or guard columns) sit on the **nullable** side — NULL-padding can flip guard satisfaction. Specifically:
  - `left`: drop right-side guarded FDs (already dropped along with right's FDs today); left-side guarded FDs survive iff none of their guard columns or dependents are nullable post-join (always true for left side of a left join).
  - `right`: mirror.
  - `full`: drop everything as today.
- **Project / Aggregate / Returning** (`project-node.ts`, `aggregate-node.ts`, `stream-aggregate.ts`, `hash-aggregate.ts`, `returning-node.ts`): `projectFds` handles this. The update to `projectFds` above already drops guarded FDs whose guard column isn't preserved.
- **Distinct / Alias / Window / Set / Sort / Limit / OrdinalSlice / TableAccess / Retrieve**: pass-through. No code change needed once `addFd` / `mergeFds` / `shiftFds` correctly preserve the `guard` field.
- **Scan / TableReference**: simply emits guarded FDs into its initial property set when extraction produces them.

### Source: implication-form CHECK constraints

Extend `packages/quereus/src/planner/analysis/check-extraction.ts` `recognize()`:

A top-level disjunction `binary { operator: 'OR' }` is treated as implication: `(¬G_1 ∧ ¬G_2 ∧ ... ∧ ¬G_k) ⇒ body`. The recognized shape is:

```
(g_1) or (g_2) or ... or (g_k) or (body)
```

In practice users write `(status <> 'active') or (x = y)` — i.e. one branch is the negated guard, the other is the implied equality. The implementation:

1. Flatten any `(a or b or c)` into a list of disjuncts.
2. Take the **last** disjunct as the body. For all preceding disjuncts, attempt to recognize each as the negation of an equality/is-null clause:
   - `col <> literal` ⇒ guard clause `eq-literal {col, literal}`.
   - `col1 <> col2` ⇒ guard clause `eq-column {col1, col2}`.
   - `col is not null` ⇒ guard clause `is-null {col, negated: false}`.
   - `col is null` ⇒ guard clause `is-null {col, negated: true}`.
   - Anything else ⇒ the whole CHECK is not implication-form; skip without contribution.
3. Recognize the body via a reuse of the existing equality recognizer (`handleEquality`), but emitting guarded FDs/equiv pairs. **Domain constraints are NOT lifted from implication-form CHECKs** — a range or enum that holds only under a guard isn't safely consumable until the guard activation path also threads through domains, which is out of scope here.
4. Equivalence pairs from a guarded body do **not** participate in the table's EC list — equivalences are unconditional facts. Instead, the guarded equality `body = col1 = col2` emits two guarded FDs `{col1} → {col2}` and `{col2} → {col1}` only. Filter activation will turn them into unconditional FDs which the Filter's own EC-merge step can use.

Update `CheckExtraction` so the API surface is unchanged from the caller's perspective — the guarded FDs flow back through the same `fds` list. `equivPairs`, `constantBindings`, `domainConstraints` continue to carry only unconditional contributions.

### Domain / docs

- Update `docs/optimizer.md` § Functional Dependency Tracking: add a "Guarded FDs" subsection describing the type extension, activation at Filter, and the propagation table notes (outer-join nullable-side drop; projection drop when guard columns vanish).

## Test outline — `packages/quereus/test/optimizer/conditional-fds.spec.ts`

### Unit (`predicateImpliesGuard`)

- `eq-literal` direct match: predicate `c = 'x'`, guard `{c='x'}` → true.
- `eq-literal` via EC: predicate `c1 = 'x' and c1 = c2`, guard `{c2='x'}` → true.
- `eq-literal` via binding: source already has binding `c → 'x'`, predicate trivial → true.
- `eq-column` via EC: source EC `{c1, c2}` already in place → true.
- `eq-column` via predicate conjunct: predicate `c1 = c2` → true.
- `is-null` direct: predicate `c is null` matches guard `{c is null}` → true.
- `is-null negated` via non-nullable column: column declared `not null` → true.
- `is-null negated` via conjunct: predicate `c is not null` → true.
- Conservative false: predicate `c > 5`, guard `{c='x'}` → false.
- Conservative false: predicate `c = 'x' or c = 'y'` (top-level OR — caller must already conjunct-walk) → false.

### Unit (check extraction)

- `check (status <> 'active' or assigned_region = customer_region)` produces one guarded FD `{customer_region} → {assigned_region}` and one `{assigned_region} → {customer_region}`, both with guard `[{eq-literal status 'active'}]`. **Not** EC-merged.
- `check (deleted_at is not null or x = y)` produces guarded FDs with guard `[{is-null deleted_at negated:false}]`.
- `check (a <> 1 or b <> 2 or x = y)` — two guard clauses, both must hold.
- `check (status = 'active')` — no implication shape, falls through to existing equality recognition.

### End-to-end via `query_plan`

Schema:
```sql
create table t (
  customer_region text not null,
  assigned_region text not null,
  status text not null,
  check (status <> 'active' or assigned_region = customer_region)
);
```

- `select distinct customer_region, assigned_region from t where status = 'active'` — assert the `distinct` node's `physical.fds` (or `isSet` derivation) shows DISTINCT reducible to `customer_region` alone (guard activated; assigned_region functionally determined).
- Same `select` without `where status = 'active'` — DISTINCT does **not** reduce; assigned_region not determined.
- `select * from t where status = 'active' and customer_region = 'east'` — both columns pinned; FD chain activates.
- Outer-join nullable-side: `t1 left join t2 on ...` where `t2` carries a guarded FD; assert it doesn't appear on the output side.

## Out of scope

- **Partial-unique-index guarded keys** — sister tickets `fd-capitalize-on-partial-unique-indexes` (plan/) and `fd-conditional-fd-from-partial-unique-index` (backlog/) handle this source independently.
- **Conditional INDs** (`{type='order'} → customer_id ⊆ customers.id`) — separate ticket, intersects with `optimizer-ind-existence-reasoning` (now complete) only after both this and IND work agree on guard shapes.
- **Multi-clause logical OR inside guards** — not supported; guards are conjunctions only.
- **Guard simplification under closure** — initial pass uses raw clauses; e.g., a guard `[{eq-literal c 'x'}, {eq-literal c 'y'}]` would be infeasible but we don't detect that.
- **Domain constraints under guards** — see implementation note above.
- **NOT-wrapped CHECK shapes** for implication — `not (c = 'x' and not p)` is logically the same as the OR form but is not recognized here; users are expected to write the OR form.

## TODO

### Phase 1 — Type + helpers

- Extend `FunctionalDependency` in `plan-node.ts` with optional `guard: GuardPredicate`; define `GuardPredicate` / `GuardClause` types next to it.
- Update `fd-utils.ts`:
  - `fdsEqual` to compare guards structurally.
  - `addFd` / `mergeFds`: same-determinants collapse only when guards are equal.
  - `computeClosure`: skip any FD whose `guard !== undefined`.
  - `projectFds`: drop a guarded FD whose guard references a column missing from the mapping.
  - `shiftFds`: shift guard column indices alongside determinants/dependents.
  - Add `predicateImpliesGuard(predicate, guard, ecs, bindings, attrIdToIndex, isColumnNonNullable)`; export it.
  - Add a small helper to strip a guard (return the unconditional twin) for use by Filter activation.
- Unit tests for the helpers above (extend an existing `fd-utils.spec.ts` if present; otherwise create one).

### Phase 2 — Check extraction

- In `check-extraction.ts`, add an OR-disjunction branch to `recognize()`:
  - Flatten nested `or` into a flat disjunct list.
  - Try to parse all-but-last disjuncts as guard-clause negations; bail out if any fails.
  - Recognize body as guarded equality only (no domain contribution from implication form).
  - Emit guarded FDs onto the existing `fds` array; do **not** push EC pairs or bindings.
- Unit tests in `check-extraction` spec for the four implication patterns above.

### Phase 3 — Filter activation

- Refactor `FilterNode.computePhysical` so EC/binding merge happens **before** guarded-FD activation.
- Activate inherited guarded FDs; replace with unconditional twin when entailed.
- E2e tests per the outline.

### Phase 4 — Propagation polish

- Verify `propagateJoinFds` handles outer-join nullable-side drop correctly — the existing left/right cases already drop the nullable side's FDs wholesale, so this is mostly a confirmation. Add an explicit guarded-FD test.
- Confirm `projectFds` drop-on-guard-column-loss works through Project / Aggregate.

### Phase 5 — Docs + validation

- Update `docs/optimizer.md` § FD Tracking with the "Guarded FDs" subsection and propagation-table notes.
- Run `yarn workspace @quereus/quereus run lint` and `yarn workspace @quereus/quereus run test`; stream logs (`2>&1 | tee /tmp/foo.log`).
- Pre-existing store/sample-plugin failures noted in the prereq's review may also appear here; verify they're unrelated.
