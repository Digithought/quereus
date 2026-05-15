---
description: Extract FDs, equivalence classes, constant bindings, and column-domain bounds from declared `check` constraints at schema-load time and feed them into the existing FD/EC/binding pipeline. Adds a new `domainConstraints` physical property for range/enum bounds.
files:
  - packages/quereus/src/schema/table.ts
  - packages/quereus/src/schema/manager.ts
  - packages/quereus/src/planner/nodes/plan-node.ts
  - packages/quereus/src/planner/nodes/reference.ts                  # TableReferenceNode lives here
  - packages/quereus/src/planner/util/fd-utils.ts
  - packages/quereus/src/planner/analysis/check-extraction.ts        # new
  - packages/quereus/src/planner/nodes/filter.ts
  - packages/quereus/src/planner/nodes/project-node.ts
  - packages/quereus/src/planner/nodes/aggregate-node.ts
  - packages/quereus/src/planner/nodes/join-node.ts
  - packages/quereus/src/planner/nodes/set-operation-node.ts
  - packages/quereus/src/planner/nodes/distinct-node.ts
  - packages/quereus/test/optimizer/check-derived-fds.spec.ts        # new
  - docs/optimizer.md
  - docs/architecture.md
---

## Goal

Surface declared `check` constraints to the optimizer at the table-reference node, in the same form the FD/EC/`constantBindings` framework already consumes. Adds a new `domainConstraints` physical property for range/enum bounds. Every existing FD consumer (DISTINCT elimination, GROUP-BY simplification, decorrelation, join elimination) benefits without writing new optimizer rules.

This ticket is foundation for `optimizer-conditional-fds`, `optimizer-predicate-contradiction-detection`, and `optimizer-assertion-as-rewrite-premise`.

## Design

### Extraction approach: AST walker (not synthetic plan-node build)

`extractEqualityFds` operates on `ScalarPlanNode`. Reusing it would require planning each check expression in a synthetic per-table-reference scope — heavy, and complicated by attribute-ID stability across `TableReferenceNode` instances (attribute IDs are minted per instance via `PlanNode.nextAttrId()`, so a cached pre-built plan-node tree would carry stale IDs).

Instead, walk `AST.Expression` (the `expr` field on `RowConstraintSchema`) directly, mapping column **names** to column **indices** via `tableSchema.columnIndexMap`. Output is plain column-index records — no attribute IDs involved. The shapes we recognize are syntactic, so an AST walker is the right granularity. We do not call `extractEqualityFds` from this path; the AST walker emits the same record shapes (`FunctionalDependency` / equivalence pair / `ConstantBinding`) directly.

Schema-time extraction lives in `planner/analysis/check-extraction.ts`. Result is cached on the `TableSchema` so repeated `TableReferenceNode.computePhysical` calls don't re-walk.

### New physical property: `domainConstraints`

In `planner/nodes/plan-node.ts`:

```typescript
export type DomainConstraint =
  | { kind: 'range';
      column: number;            // output column index
      min?: SqlValue;            // present iff a lower bound is known
      max?: SqlValue;            // present iff an upper bound is known
      minInclusive: boolean;     // ignored if min absent
      maxInclusive: boolean }    // ignored if max absent
  | { kind: 'enum';
      column: number;
      values: ReadonlyArray<SqlValue> };

interface PhysicalProperties {
  // ... existing fields ...
  domainConstraints?: ReadonlyArray<DomainConstraint>;
}
```

Notes:
- `notNull` is already a column-schema property; do not duplicate.
- Ranges and enums may both exist on the same column; intersection is **out of scope** (deferred to ticket #4).
- Multiple constraints for the same column on the same kind: keep both (don't merge) at this stage — consumers handle that.

### Helpers (new in `planner/analysis/check-extraction.ts`)

```typescript
interface CheckExtraction {
  readonly fds: ReadonlyArray<FunctionalDependency>;        // ∅→col, col→col pairs
  readonly equivPairs: ReadonlyArray<readonly [number, number]>;
  readonly constantBindings: ReadonlyArray<ConstantBinding>;
  readonly domainConstraints: ReadonlyArray<DomainConstraint>;
}

function extractCheckConstraints(
  checks: ReadonlyArray<RowConstraintSchema>,
  columnIndexMap: ReadonlyMap<string, number>,
  isDeterministic: (fnName: string, argc: number) => boolean,
): CheckExtraction;
```

The `isDeterministic` callback comes from the schema manager (it already does this check at validation time — see `validateCheckConstraintDeterminism`). We re-use that signal to skip checks containing non-deterministic function calls.

Recognized AST shapes (per check; conjunctions decompose):

| AST shape (informally) | Output |
| --- | --- |
| `<col> = <col>` | bi-directional FDs + EC pair |
| `<col> = <literal>` | `∅ → col` FD + literal binding |
| `<col> = <col-expr>` where the only column referenced is `a` | `a → b` FD (one-way, no EC) |
| `<col> >= <lit>`, `<col> > <lit>` | range with `min` (exclusive on `>`) |
| `<col> <= <lit>`, `<col> < <lit>` | range with `max` (exclusive on `<`) |
| `<col> between <lit> and <lit>` | range with both bounds inclusive |
| `<col> in (<lit-list>)` | enum with the literal values |
| `<expr-a> and <expr-b>` | recurse into both |

Skipped (no contribution):
- Disjunctions (`or`). The contradiction-detection ticket (#4) will revisit.
- `not` wrapping anything but a recognized shape we can negate trivially (this ticket: skip `not` entirely).
- Subqueries inside the check.
- Any function call where `isDeterministic(name, argc)` returns false.
- `coalesce`/`case`/`cast` and other non-trivial wrappers — only literal expressions count as constants for binding/domain purposes. Use the same "literal expression" predicate the existing fingerprint/const-evaluator code uses (or a small local helper that accepts AST literal nodes only).

For `<col> = <col-expr>` (general functional-equality case): an AST walker over `<col-expr>` collects the set of column names referenced. If exactly one column name `a` appears (and the expression is otherwise free of non-determinism per the callback above), emit `a → b`. No EC, no constant binding. This is conservative but matches the spec ("`check (b = a + 1)`").

### Domain helpers (in `fd-utils.ts` or alongside extraction)

Mirror the existing `mergeConstantBindings` / `projectConstantBindings` / `shiftConstantBindings` shapes:

```typescript
function mergeDomainConstraints(
  a: ReadonlyArray<DomainConstraint>,
  b: ReadonlyArray<DomainConstraint>,
): ReadonlyArray<DomainConstraint>;

function projectDomainConstraints(
  domains: ReadonlyArray<DomainConstraint>,
  sourceToOutputMapping: ReadonlyMap<number, number>,
): ReadonlyArray<DomainConstraint>;

function shiftDomainConstraints(
  domains: ReadonlyArray<DomainConstraint>,
  offset: number,
): ReadonlyArray<DomainConstraint>;
```

- `merge`: append + dedup-by-structural-equality (don't intersect — intersection is ticket #4).
- `project`: drop any constraint whose column is not in the mapping; remap survivors.
- `shift`: add `offset` to every column index.

### Schema caching

Add a `getCheckExtraction(table: TableSchema): CheckExtraction` accessor — or a lazy field on `TableSchema` materialized on first read. Either approach works; prefer storing it via a `WeakMap<TableSchema, CheckExtraction>` keyed by the schema instance so we don't widen `TableSchema`'s public shape unnecessarily and the cache is automatically invalidated when ALTER TABLE replaces the schema instance (it does — see `schema.addTable(updatedTableSchema)` in `runtime/emit/add-constraint.ts` and `runtime/emit/alter-table.ts`).

### Per-operator propagation

| Operator | `domainConstraints` behavior |
| -------- | ---------------------------- |
| `TableReferenceNode` | **Seed** from the cached `CheckExtraction` for `tableSchema`. Also seed `fds` (merged with the existing PK/UNIQUE-derived set), `equivClasses`, and `constantBindings`. Close bindings over the resulting EC list. |
| `Filter` | Inherit from source. **Do not intersect** with filter predicate — deferred to ticket #4. (The filter already inherits `constantBindings`; mirror that exactly for `domainConstraints`.) |
| `Project` / `Returning` | Project through source→output mapping; drop on non-bare-column outputs. |
| `Aggregate` family | Project through GROUP BY; drop on aggregated columns. |
| `Join` (inner/cross) | Concat source + (shifted) right; outer joins keep preserved-side only; full outer drops both. |
| `SetOperation` | Drop conservatively. |
| `Distinct` / `Alias` / `Window` / scan family | Pass through. |

Each operator's `computePhysical` already has the FD/EC/binding propagation pattern; insert the `domainConstraints` propagation alongside it (using the new helpers). Re-use the existing source→output column index mapping helpers where they already exist.

### Equivalence-class closure

When seeding `TableReferenceNode`, after merging FDs and ECs from PK/UNIQUE keys with check-derived contributions:
- Call `closeConstantBindingsOverEcs` so a check binding like `status = 'a'` together with an EC `{status, alt_status}` (from another check `status = alt_status`) yields a binding on both columns. Matches what `FilterNode` does for predicate-derived bindings.

## Test outline — `test/optimizer/check-derived-fds.spec.ts`

Mirror the structure of `fd-equivalence.spec.ts` (unit + plan-introspection).

**Unit tests on `extractCheckConstraints`** — build small `RowConstraintSchema[]` arrays directly and verify the four output arrays:

- `check (a = b)` → two FDs (a↔b) + one EC pair, no bindings, no domains.
- `check (status = 'a')` → one `∅ → status` FD, one literal binding, no domains.
- `check (qty >= 0)` → range domain `{column: <qty>, min: 0, minInclusive: true}`, no FDs.
- `check (qty between 0 and 100)` → range with both bounds, both inclusive.
- `check (qty > 0 and qty < 100)` → range with `min` exclusive, `max` exclusive. (Conjunction decomposes but emits two range constraints in this pass; intersection is ticket #4.)
- `check (status in ('a','i','d'))` → enum domain on `status`.
- `check (a = b and status = 'a')` → all of: bi-FDs, EC, binding.
- `check (a = b or x = y)` — disjunction → no contribution.
- `check (a > b)` — non-equality column-column → no FD; no domain (not single-column-bound).
- `check (b = a + 1)` → one-way FD `a → b`, no EC, no binding, no domain.
- `check (b = a + c)` (two columns on RHS) → no contribution.
- `check (b = some_nondeterministic_fn(a))` (per `isDeterministic` callback) → no contribution.

**End-to-end via `query_plan(?)`** — using `planRows`/`physicalOf` helpers copied from `fd-equivalence.spec.ts`:

- Table with `check (b = a + 1)`: `SELECT * FROM t` shows FDs including `a → b` at the `TableReference` row.
- Table with `check (status in ('a','i'))`: `SELECT * FROM t` shows `domainConstraints` containing the enum.
- Table with `check (status = 'a')`: the existing DISTINCT-elimination rule fires for `SELECT DISTINCT status FROM t` (verify by checking the optimized plan has no `Distinct` node, or that the `TableReference` carries `∅ → status`).
- Existing GROUP-BY-by-PK simplification triggers when a check pins a non-PK column to a constant (`SELECT status FROM t GROUP BY status` with `check status = 'a'`).
- Join propagation: domains on the inner side of an inner join survive (`SELECT * FROM t JOIN u ON t.id = u.id` where `t.status in (...)` survives at the join output); outer join (`t LEFT JOIN u`) drops the nullable side's domains.
- Filter pass-through: `SELECT * FROM t WHERE x > 0` preserves the table's `domainConstraints` at the Filter row.

## Out of scope

- **Domain intersection at filter time** — ticket #4 (`optimizer-predicate-contradiction-detection`).
- **Conditional FDs** — ticket #3 (`optimizer-conditional-fds`).
- **Assertion-derived constraints** — ticket #5 (`optimizer-assertion-as-rewrite-premise`).
- **FK-derived inclusion dependencies** — separate track (`optimizer-ind-existence-reasoning`).
- **Merging multiple range constraints on the same column** at this layer — leave as multiple `DomainConstraint` entries.

## Docs

- `docs/optimizer.md` § *Functional Dependency Tracking* — add a row for "check-derived" sources alongside the existing per-operator propagation table. Add a short subsection on `domainConstraints` with the type definition and the propagation rules above.
- `docs/architecture.md` § *Functional-Dependency Tracking* — one paragraph mentioning that declared CHECK constraints contribute FDs/ECs/bindings/domains at the table reference.

## TODO (carry into implement)

Phase 1 — type + helpers
- Define `DomainConstraint` (and the union) in `plan-node.ts`; add `domainConstraints?` to `PhysicalProperties`.
- Add `mergeDomainConstraints` / `projectDomainConstraints` / `shiftDomainConstraints` (alongside the existing `*ConstantBindings` helpers).

Phase 2 — extraction
- Create `planner/analysis/check-extraction.ts` with `extractCheckConstraints` (AST walker, recognized shapes per the table above).
- Module-local helper `isLiteralExpr(ast)` accepting only `AST.LiteralExpr` (mirror how `extractEqualityFds` treats literals).
- Module-local helper `collectColumnNames(ast)` for the `b = f(a)` case.
- Use the schema manager's existing determinism check (factor out into a small predicate if currently private; keep the duplication minimal).

Phase 3 — wiring at `TableReferenceNode`
- Add the `WeakMap<TableSchema, CheckExtraction>` cache. Pull a fresh `CheckExtraction` on first read per schema instance.
- Extend `TableReferenceNode.computePhysical`: merge check-derived FDs with the existing PK/UNIQUE FDs, seed `equivClasses` / `constantBindings` / `domainConstraints`, close bindings over ECs.

Phase 4 — per-operator propagation for `domainConstraints`
- `FilterNode.computePhysical`: pass through from source (no intersection yet).
- `ProjectNode` / `ReturningNode`: project through bare-column outputs; drop otherwise.
- `AggregateNode` (and any sibling aggregate nodes): project through GROUP BY; drop on aggregated outputs.
- `JoinNode`: inner/cross — concat with shift; LEFT/RIGHT — preserved side only; FULL — drop. Match the exact pattern used for `constantBindings` so the rules are symmetric.
- `SetOperationNode`: drop.
- `DistinctNode` / `AliasNode` / `WindowNode` / scan family: pass through unchanged.

Phase 5 — tests
- `test/optimizer/check-derived-fds.spec.ts` per the outline above. Use `RowConstraintSchema[]` directly for unit tests (no need to go through `db.exec("CREATE TABLE ...")` for those); use `db.exec` + `query_plan(?)` for end-to-end.

Phase 6 — docs
- Update `docs/optimizer.md` and `docs/architecture.md` per § Docs above.

Validation:
- `yarn workspace @quereus/quereus run lint`
- `yarn test`
- Spot-check that existing DISTINCT-elimination / GROUP-BY-by-PK tests still pass (check-derived FDs are additive; they should not turn off any existing path).
