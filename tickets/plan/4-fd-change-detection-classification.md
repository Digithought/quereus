---
description: Extend `analyzeRowSpecific` to classify table references using FDs, recognizing group-specific (FD-determined grouping key) cases that today demote to global
prereq: fd-property-foundation, fd-from-equivalence-classes, fd-from-injective-projections
files:
  - packages/quereus/src/planner/analysis/constraint-extractor.ts
  - packages/quereus/src/planner/util/key-utils.ts
  - packages/quereus/src/core/transaction.ts (or wherever the assertion delta pipeline is wired)
  - packages/quereus/test/optimizer/row-specific-fd.spec.ts
  - docs/architecture.md
  - docs/optimizer.md
---

## Motivation

The assertion delta-execution pipeline classifies each table reference instance in an assertion plan as `row` (≤1 row per changed key) or `global` (potentially many rows). The current `analyzeRowSpecific` in `analysis/constraint-extractor.ts:943` uses superkey coverage as its only criterion: a reference is `row` iff equality predicates on the path fully cover a unique key, and not beneath an "identity-breaking node" (aggregate without PK grouping, set operation, window).

That last clause is too conservative. Aggregates produce row-unique output whenever the GROUP BY is a key — *or* whenever the GROUP BY *plus its FD closure* covers a key. With FD reasoning:

- `GROUP BY customer_id` followed by `WHERE customer_id = 7` ⇒ the aggregate output has at most one row even though `customer_id` may not be a key on the underlying table (if there are duplicate orders). The aggregate is `row` for binding `customer_id = 7`.
- `GROUP BY a, b` with EC `{a, b}` ⇒ same as `GROUP BY a`, so a covered key on `a` makes the aggregate `row`.
- `GROUP BY pk` always makes the aggregate `row` per its grouping key — this is the "group-specific" mode from `docs/optimizer.md`:1224, currently named but underused.

This ticket extends the classification machinery to use FDs and to expose the third category — `group` — to consumers.

## Architecture

### Updated classification API

```typescript
type RowClassification = 'row' | 'group' | 'global';

interface RowSpecificResult {
  /** Per-relationKey classification. */
  classifications: Map<string, RowClassification>;
  /** For group-classified relations, the group key columns (in their original table indices). */
  groupKeys: Map<string, number[]>;
}

function analyzeRowSpecific(plan: RelationalPlanNode): RowSpecificResult;
```

The existing call sites get a small refactor — return type changes from `Map<string, 'row' | 'global'>` to `RowSpecificResult`. The 'group' case is new.

### Classification rules

For each table reference instance with `relationKey`:

1. Walk the path from the table reference to the root. Collect equality constraints along the way (existing `extractConstraintsForTable`).
2. Compute `coveredKeys` — full-key equality coverage at any point on the path.
3. **'row'** classification: any covered key found AND no row-multiplying node above the table reference (aggregate without grouping coverage, set operation that adds, window that re-emits).
4. **'group'** classification (new): the path includes an aggregate (`AggregateNode`, `StreamAggregateNode`, `HashAggregateNode`) whose GROUP BY columns, plus the FD closure at the aggregate's input, fully cover a unique key of the table reference. The grouping is therefore key-aligned; one input row per group ⇒ one output row per group ⇒ the table reference is `group`-specific (≤1 row per group key).
5. **'global'** classification: anything else.

The FD closure is computed from `aggregate.source.physical.fds` (post-FD-foundation ticket). The closure of the GROUP BY columns gives the set of attributes fully determined by them at the aggregate's input; if that set includes a unique key of the table reference, the aggregate is grouping-by-key.

### `group` key extraction

When a reference is `group`, the consumer needs to know *what* the group key is — i.e., which set of columns to bind to identify the affected output row. The result stores this:

```typescript
groupKeys.set(relationKey, [/* column indices of the group key in the original table */]);
```

For `GROUP BY a, b` where `(a, b)` covers a UNIQUE on the source: `groupKeys` for that source's relationKey is `[index_of_a, index_of_b]`.

### Window and set operations

Window functions partition by some columns and emit one output row per input row (so the input cardinality is preserved). A WindowNode does NOT multiply rows — it preserves the input row identity. Therefore a table reference beneath a Window can still be `row` if its predicate covers a key. The current `demoteForIdentityBreakingNodes` conservatively demotes — refine: don't demote on Window. (Only demote when actual row-multiplication occurs, like in Aggregate-without-key-coverage or SetOperation.)

For SetOperation (UNION ALL, etc.): row count can increase but row identity doesn't change. A predicate on one branch's table reference doesn't bind the other branch's references. The current "always demote" is correct for ANY-branch classification; per-branch classification would be more refined but requires per-branch relationKey tracking. Deferred — leave the SetOperation demotion as-is.

### `coveredKeysByTable` extension

`constraint-extractor.ts:140` builds `coveredKeysByTable: Map<string, number[][]>` from equality coverage. Extend it to also consume FDs — a "covered key" is now "a unique key whose columns are in the closure of the equality-covered columns."

Concretely, given equality-covered columns `E` and the source's `fds`/`equivClasses`:

```typescript
const closure = computeClosure(new Set(E), fds, equivClasses);
const covered = uniqueKeys.filter(k => k.every(col => closure.has(col)));
```

This means a single equality on a "naming" column that's part of a UNIQUE constraint covers the PK transitively if there's an FD chain. Significant generalization with no cost to the rest of the system.

### Consumer updates

The assertion delta pipeline (`core/transaction.ts` or wherever assertion COMMIT eval lives — locate during implementation; ticket can't pre-determine the exact file) currently switches on `'row'` vs `'global'`. Extend to:

- `'row'`: existing parameterized variant by full key.
- `'group'`: parameterized variant by group key. The aggregate's output for a given group key is uniquely determined; the residual check runs once per changed group.
- `'global'`: existing fallback to full violation query.

This matches the design already documented in `docs/optimizer.md` § "Binding-aware Delta Planning" lines 1220–1247, which named the three modes but the analysis only delivers two today.

### Determining the group key for a changed row

When a row in table `T` changes, the assertion runner needs to know which group keys to check. The mapping is the GROUP BY columns themselves projected back to `T`'s table-output indices — already part of the `groupKeys` result above. For each changed row in `T`:

- Read the GROUP BY column values from the row (OLD or NEW for UPDATE; OLD for DELETE; NEW for INSERT).
- Use those values as parameters in the parameterized assertion variant.

If the GROUP BY columns are not in the assertion's residual filter directly (they're inferred via FD), the parameterized variant binds the *closure-determining* column instead. The mapping is captured during `analyzeRowSpecific`.

## Use cases enabled

- Assertions that group by FK can now be re-checked per affected group rather than full-scanned. This is the canonical "no two orders per customer in same day" assertion.
- The naming of `group` as a first-class mode enables consumers beyond assertions to use it (next ticket: view maintenance).
- Better classification accuracy reduces full-scan fallbacks in the assertion COMMIT path.

## Tests

- Unit test: `GROUP BY customer_id` (where `customer_id` is FK to a PK) classifies the source table as `group` with `groupKeys = [customer_id_index]`.
- Unit test: `GROUP BY a, b WHERE a = b` (EC class) classifies as `group` with `groupKeys = [a_index]` (minimal).
- Unit test: aggregate without key-covering GROUP BY classifies as `global`.
- Unit test: window function above table reference classifies as `row` (no longer demoted unconditionally).
- Integration test with assertion: create an assertion that groups by an FK column, verify the COMMIT-time evaluation uses parameterized per-group execution.

## Documentation

- **docs/architecture.md** — update the assertion / constraint section to mention the three-way classification (row, group, global) and the FD basis for `group` recognition.
- **docs/optimizer.md** — update the "Row-specific vs Global Classification for Assertions" section (lines ~1113–1219) to describe the new `group` mode and the FD-based covered-key extension. Update the "Binding-aware Delta Planning" section (lines ~1220–1247) to point at the new analyzer output.

## Out of scope

- The new `'group'` classification's runtime support in the assertion COMMIT pipeline — concept lands here; runtime wiring is the responsibility of the next ticket (`fd-view-maintenance-binding-keys`) or a dedicated runtime ticket.
- Per-branch classification of SetOperation tables. Deferred.
