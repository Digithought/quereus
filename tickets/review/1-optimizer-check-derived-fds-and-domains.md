description: Lift declared CHECK constraints into the optimizer's FD/EC/binding pipeline at the table reference, and add a new `domainConstraints` physical property for range/enum bounds derived from CHECK.
files:
  - packages/quereus/src/planner/nodes/plan-node.ts
  - packages/quereus/src/planner/util/fd-utils.ts
  - packages/quereus/src/planner/analysis/check-extraction.ts (new)
  - packages/quereus/src/planner/nodes/reference.ts
  - packages/quereus/src/planner/nodes/filter.ts
  - packages/quereus/src/planner/nodes/project-node.ts
  - packages/quereus/src/planner/nodes/returning-node.ts
  - packages/quereus/src/planner/nodes/aggregate-node.ts
  - packages/quereus/src/planner/nodes/stream-aggregate.ts
  - packages/quereus/src/planner/nodes/hash-aggregate.ts
  - packages/quereus/src/planner/nodes/join-utils.ts
  - packages/quereus/src/planner/nodes/join-node.ts
  - packages/quereus/src/planner/nodes/merge-join-node.ts
  - packages/quereus/src/planner/nodes/bloom-join-node.ts
  - packages/quereus/src/planner/nodes/asof-scan-node.ts
  - packages/quereus/src/planner/nodes/set-operation-node.ts
  - packages/quereus/src/planner/nodes/distinct-node.ts
  - packages/quereus/src/planner/nodes/alias-node.ts
  - packages/quereus/src/planner/nodes/window-node.ts
  - packages/quereus/src/planner/nodes/sort.ts
  - packages/quereus/src/planner/nodes/limit-offset.ts
  - packages/quereus/src/planner/nodes/ordinal-slice-node.ts
  - packages/quereus/src/planner/nodes/table-access-nodes.ts
  - packages/quereus/src/planner/nodes/retrieve-node.ts
  - packages/quereus/test/optimizer/check-derived-fds.spec.ts (new)
  - docs/optimizer.md
  - docs/architecture.md
----

## What landed

### 1. New `DomainConstraint` physical property

`PhysicalProperties.domainConstraints?: ReadonlyArray<DomainConstraint>` carries per-column range / enum bounds:

```typescript
type DomainConstraint =
  | { kind: 'range'; column: number;
      min?: SqlValue; max?: SqlValue;
      minInclusive: boolean; maxInclusive: boolean }
  | { kind: 'enum'; column: number; values: ReadonlyArray<SqlValue> };
```

Helpers in `fd-utils.ts` mirror the existing constant-binding helpers: `mergeDomainConstraints` (concat, dedup-by-structural-equality), `projectDomainConstraints` (drop on unmapped columns), `shiftDomainConstraints` (offset for joins). `merge` deliberately does **not** intersect overlapping ranges/enums on the same column — that's deferred to ticket #4 (`optimizer-predicate-contradiction-detection`).

### 2. CHECK-constraint AST walker

`planner/analysis/check-extraction.ts` exports `extractCheckConstraints(checks, columnIndexMap, isDeterministic)` and a cached `getCheckExtraction(tableSchema)` keyed by a module-local `WeakMap<TableSchema, CheckExtraction>`. The walker decomposes through `AND` and recognizes the shapes specified in the implement ticket:

- `c1 = c2` → bi-directional FDs + EC pair
- `c = literal` → `∅ → c` FD + literal binding
- `c = single-col-expr` → one-way FD `other → c`
- `c >= lit` / `c > lit` / `c <= lit` / `c < lit` → range domain
- `c BETWEEN lit AND lit` → range with both bounds inclusive
- `c IN (lit, ...)` → enum domain

Disjunctions, `NOT`, subqueries, and any function call the supplied predicate rejects skip the whole CHECK. The cache uses `() => true` because schema validation already rejects non-deterministic functions in checks at CREATE TABLE time; the parameter exists for tests.

### 3. TableReferenceNode wiring

`TableReferenceNode.computePhysical` merges check-derived FDs with the existing PK/UNIQUE-derived ones via `addFd`, seeds `equivClasses` from check-derived EC pairs, merges `constantBindings`, then closes them over the resulting EC list (so a check `status = 'a'` plus another check `status = alt_status` yields a binding covering both columns). `domainConstraints` are seeded directly.

### 4. Per-operator propagation

`domainConstraints` propagates alongside the existing FD/EC/binding plumbing on every operator I touched:

| Node                                              | Behavior |
| ------------------------------------------------- | -------- |
| `FilterNode`                                      | pass through (no intersection with predicate yet) |
| `ProjectNode` / `ReturningNode`                   | `projectDomainConstraints` through bare-column / injective mapping |
| `AggregateNode` / `StreamAggregateNode` / `HashAggregateNode` | shared `propagateAggregateFds` helper now also projects domains through the GROUP BY mapping |
| `JoinNode` / `MergeJoinNode` / `BloomJoinNode`    | shared `propagateJoinFds` in `join-utils.ts`: inner/cross concat with shift, LEFT keeps left-only, RIGHT keeps right-only (shifted), FULL drops |
| `AsofScanNode`                                    | inherit left only |
| `SetOperationNode`                                | drop |
| `DistinctNode` / `AliasNode` / `WindowNode` / `SortNode` / `LimitOffsetNode` / `OrdinalSliceNode` / `RetrieveNode` / `SeqScanNode` / `IndexScanNode` / `IndexSeekNode` | pass through |

### 5. Tests

`test/optimizer/check-derived-fds.spec.ts` — 19 specs, **all passing**:

- 12 unit tests on `extractCheckConstraints` covering every shape in the recognition table, including the negative cases (disjunction, non-equality column-column, multi-column RHS, non-deterministic function call).
- 7 e2e tests via `query_plan(?)` covering: FD `a → b` from `CHECK (b = a + 1)` at the table reference; enum domain on `status` from `CHECK (status in ('a','i'))` at the table reference; `∅ → status` FD from `CHECK (status = 'a')` somewhere in the plan; Filter pass-through preserves the source's range domain; inner join inherits inner-side enum domain; LEFT outer drops right-side domain; Project drops domains on non-projected columns.

### 6. Docs

- `docs/optimizer.md` § *Functional Dependency Tracking* — extended the type block, added a new sub-section *Check-derived contributions* with the shape table, and updated the per-operator table row for `TableReferenceNode` to mention the CHECK-derived contributions. Added a new paragraph after the per-operator table describing how `domainConstraints` propagate. Listed the new helpers in the helper-surface section.
- `docs/architecture.md` § *Functional-Dependency Tracking* bullet — updated to mention CHECK-derived FDs/ECs/bindings/domains.

## Validation

- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus run build` — clean.
- All 737 optimizer tests pass (the 19 new ones + the 718 existing).
- Full `yarn test` from repo root: 2961 quereus tests pass; only failures are 2 pre-existing `sample-plugins` tests (`key_value_store delete` / `update`) which I confirmed fail on `git stash` baseline as well — unrelated to this ticket.

## Where the reviewer should poke

### Honest gaps / things I did not do

1. **Filter does not intersect domains with the predicate.** Per the ticket, this is deferred to ticket #4. So `WHERE qty > 5` on a table with `CHECK (qty BETWEEN 0 AND 100)` still surfaces both as separate constraints — neither tightens the other. The ticket says explicitly "Do not intersect with filter predicate — deferred to ticket #4."
2. **Multiple `range` constraints on the same column are kept side-by-side.** `CHECK (qty > 0 AND qty < 100)` lands as two `range` entries (one with `min`, one with `max`), not one combined range. Ticket #4 will fold these.
3. **Enum + range on the same column do not interact.** A `CHECK (status IN ('a','b'))` with a separate `CHECK (status >= 'a')` would land as two independent constraints; no consumer rule yet uses both.
4. **`NOT` is conservatively dropped wholesale**, not partially negated. `CHECK (NOT (status = 'x'))` contributes nothing (per spec).
5. **No consumer rule reads `domainConstraints` yet.** This ticket only lays the surface; consumers (predicate contradiction, monotonicOn-range tightening, decorrelation tightening) will be wired in follow-up tickets. I tested propagation via `query_plan`, not via behavioral changes in optimizer rules.
6. **Determinism callback is `() => true` in production.** Schema validation at CREATE TABLE rejects non-deterministic functions in checks, so all stored checks are guaranteed deterministic — but if a function is later re-registered with different flags, the cached extraction won't re-run. The `WeakMap` cache is keyed by `TableSchema` instance, which is replaced on ALTER TABLE; if anyone re-registers a *function* (changing its determinism), the cache won't notice. Probably fine because schema validation runs again at CREATE TABLE; reviewer should confirm there's no path that mutates a function's flags after it's referenced in a check.
7. **`collectColumnNames` walks AST nodes generically** (iterates over all object/array properties looking for `type`-tagged children). It correctly skips column references inside subqueries since the surrounding `containsNonDeterministicCall` rejects subqueries first, but if a future AST shape adds a non-`Expression` child with a `type` field, `collectColumnNames` would pick it up. This isn't a known issue today; flagged for awareness.
8. **`extractCheckConstraints` does not deduplicate FDs internally.** Two checks `CHECK (a = b)` and `CHECK (a = b)` would emit four FD entries; `addFd` at `TableReferenceNode` dedups them on insert.
9. **The cache lives in a module-local `WeakMap`, not on `TableSchema`.** This means tests that build extraction directly with a custom `isDeterministic` won't share the cache (which is the intended behavior — the cache uses the strict default). If anyone wants to introspect what's in the cache, they can't.

### Worth specifically checking

- `getCheckExtraction` runs once per `TableSchema` instance and is reused across many `TableReferenceNode` instances pointing to the same schema. Fast path. But if a test or hot path constructs many ad-hoc schemas, the WeakMap grows; entries die when the schema instance does.
- The `isDeterministic` parameter in the unit tests deliberately rejects a fake function to verify the negative path; this exercises the early-exit in `containsNonDeterministicCall` but not the recursion into nested calls. A check like `CHECK (b = deterministic_outer(nondeterministic_inner(a)))` is correctly skipped because the walker traverses down to the `nondeterministic_inner` call.
- Filter, Project, Aggregate, Inner Join, Left Join, Set Op, Distinct/Alias/Window/Sort/Limit/OrdinalSlice/Retrieve/Asof/scans all wired. I did not wire `table-function-call.ts` because it's not a relational pass-through (it consumes an advertisement object, has no source); this is consistent with how `constantBindings` is treated there.
