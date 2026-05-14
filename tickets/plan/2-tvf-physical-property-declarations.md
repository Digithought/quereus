---
description: Extend TableValuedFunctionSchema so TVF authors can declare the full set of physical/logical properties (FDs, ordering, monotonicOn, estimatedRows, isSet, access capabilities) that propagate to TableFunctionCallNode
prereq: fd-property-foundation
files:
  - packages/quereus/src/schema/function.ts
  - packages/quereus/src/planner/nodes/table-function-call.ts
  - packages/quereus/src/func/builtins/json-tvf.ts
  - packages/quereus/src/func/builtins/generation.ts
  - packages/quereus/src/func/builtins/explain.ts
  - packages/quereus/src/func/builtins/schema.ts
  - packages/quereus/test/planner/tvf-physical-properties.spec.ts
  - docs/optimizer.md
  - docs/architecture.md
---

## Motivation

Table-valued functions are first-class relational sources — they appear in the FROM clause and feed into joins, filters, aggregates, etc. But unlike vtab modules (which advertise rich capabilities through `getBestAccessPlan` / `supports`), today's `TableValuedFunctionSchema` (`packages/quereus/src/schema/function.ts:122`) declares almost nothing about its output:

- `returnType: RelationType` — column shape, plus a logical `keys` field that almost no built-in TVF populates.
- That's it.

So `TableFunctionCallNode.getType()` returns a `RelationType` with `isSet: false` and `keys: []` for every built-in TVF, the `physical` getter returns defaults, and any downstream rule that could exploit TVF properties (sort elimination, key propagation, monotonic LIMIT pushdown, FD-derived simplifications) silently fails to fire.

Some real examples this blocks today:

- `generate_series(1, n)` produces rows whose `value` column is a strictly-monotone-increasing key. The output is intrinsically ordered AND unique. Today the planner sees neither.
- `json_each(obj)` produces one row per key — `key` is unique within the result. Today the planner doesn't know.
- A user-registered TVF that wraps a sorted iterator (e.g. a time-series TVF) has no way to advertise its ordering. Downstream `ORDER BY ts` triggers an unnecessary sort.
- A TVF that produces deterministically the same rows for the same arguments is `constant`-eligible if its args are constants — relevant for constant folding. Today there's no way to declare it.

The FD work that's landing makes this gap worse: TVFs are excluded from FD propagation entirely. Even if a TVF would produce a clean FD set, there's no surface to declare it on.

This ticket adds that surface. It's broader than FD work — every physical property a plan node carries should be declarable on a TVF schema, where the value can be either statically known or computed from the arguments.

## Architecture

### Declaration surface

Add to `TableValuedFunctionSchema`:

```typescript
export interface TableValuedFunctionSchema extends BaseFunctionSchema {
  returnType: RelationType;
  implementation: TableValuedFunc | IntegratedTableValuedFunc;
  isIntegrated?: boolean;

  /**
   * Optional advertisement of the function's relational and physical properties.
   * The shape mirrors the corresponding fields on `PhysicalProperties` and
   * `RelationType`, but each may be expressed as either a static value or a
   * function of the call's operand expressions (allowing parameter-dependent
   * advertisements like `generate_series(1, n)`'s row count = n - 1).
   */
  relationalAdvertisement?: TVFAdvertisement;
}

interface TVFAdvertisement {
  /** Whether the output is a set (no duplicate rows) or a bag. Overrides RelationType.isSet. */
  isSet?: boolean | TVFAdvertiseFn<boolean>;

  /** Logical unique keys, in output column indices. */
  keys?: ReadonlyArray<ReadonlyArray<ColRef>> | TVFAdvertiseFn<ReadonlyArray<ReadonlyArray<ColRef>>>;

  /** Functional dependencies the output rows satisfy. */
  fds?: ReadonlyArray<FunctionalDependency> | TVFAdvertiseFn<ReadonlyArray<FunctionalDependency>>;

  /** Equivalence classes over output columns. */
  equivClasses?: ReadonlyArray<ReadonlyArray<number>> | TVFAdvertiseFn<ReadonlyArray<ReadonlyArray<number>>>;

  /** Ordering of output rows. */
  ordering?: ReadonlyArray<{ column: number; desc: boolean }> | TVFAdvertiseFn<...>;

  /** Monotonic-on attribute (stronger than ordering). */
  monotonicOn?: ReadonlyArray<MonotonicOnInfo> | TVFAdvertiseFn<...>;

  /** Estimated row count. Constants OK; functions of args produce parameter-dependent estimates. */
  estimatedRows?: number | TVFAdvertiseFn<number>;

  /** Access capabilities (ordinal seek, asof right). Same shape as PhysicalProperties.accessCapabilities. */
  accessCapabilities?: { ordinalSeek?: boolean; asofRight?: boolean };

  /** Determinism / readonly / idempotent / constant flags. Override the defaults inferred from `flags`. */
  deterministic?: boolean;
  readonly?: boolean;
  idempotent?: boolean;
}

/**
 * A function that computes an advertised value from the call's operand expressions
 * and the function schema. Receives operand `ScalarPlanNode`s so the implementation
 * can inspect literal values, parameter slots, or operand types as appropriate.
 */
type TVFAdvertiseFn<T> = (operands: ReadonlyArray<ScalarPlanNode>, schema: TableValuedFunctionSchema) => T | undefined;
```

The `TVFAdvertiseFn<T>` shape is critical for parameter-dependent advertisements. `generate_series(1, 100)` has estimatedRows = 100; `generate_series(1, n)` where `n` is a parameter has estimatedRows = undefined unless we can resolve the parameter at plan time (it's a parameter — we usually can't).

### TableFunctionCallNode integration

`TableFunctionCallNode` (`planner/nodes/table-function-call.ts`) gains a `computePhysical` override that consults `functionSchema.relationalAdvertisement`:

```typescript
override computePhysical(): Partial<PhysicalProperties> {
  const adv = (this.functionSchema as TableValuedFunctionSchema).relationalAdvertisement;
  if (!adv) return {};
  return {
    estimatedRows: resolveAdvertisement(adv.estimatedRows, this.operands, this.functionSchema),
    ordering: resolveAdvertisement(adv.ordering, this.operands, this.functionSchema),
    monotonicOn: resolveAdvertisement(adv.monotonicOn, this.operands, this.functionSchema),
    fds: resolveAdvertisement(adv.fds, this.operands, this.functionSchema),
    equivClasses: resolveAdvertisement(adv.equivClasses, this.operands, this.functionSchema),
    accessCapabilities: adv.accessCapabilities,
    deterministic: adv.deterministic ?? /* infer from flags */,
    readonly: adv.readonly ?? true,
    idempotent: adv.idempotent ?? true,
  };
}
```

`getType()` consults `relationalAdvertisement.isSet` and `.keys` to override the defaults from `returnType` (which is the static column shape).

### `resolveAdvertisement` helper

A tiny utility:

```typescript
function resolveAdvertisement<T>(
  spec: T | TVFAdvertiseFn<T> | undefined,
  operands: ReadonlyArray<ScalarPlanNode>,
  schema: TableValuedFunctionSchema,
): T | undefined {
  if (spec === undefined) return undefined;
  if (typeof spec === 'function') return (spec as TVFAdvertiseFn<T>)(operands, schema);
  return spec;
}
```

This lets schema authors write a static value (`estimatedRows: 100`) or a function of operands (`estimatedRows: (ops) => evaluateIfLiteral(ops[1]) ?? undefined`).

### Built-in TVF annotations

The ticket lands the *surface* + annotations for the built-in TVFs that have learnable properties:

| TVF | Properties to declare |
|---|---|
| `generate_series(start, stop, step?)` | `keys: [[{index: 0}]]` (single value column is unique); `ordering: [{column: 0, desc: step < 0}]`; `monotonicOn: [{attrId: 0, strict: true, direction: ...}]`; `estimatedRows: stop - start` when start/stop are literals. |
| `json_each(json)` | `keys: [[{index: 0}]]` for the key column (`key` is unique per JSON object); `isSet: true`; `deterministic: true`. |
| `json_tree(json)` | `isSet: true`; `deterministic: true`; no obvious key (paths can repeat in arrays of objects). |
| `query_plan(sql)` | `deterministic: true`; `isSet: false` (the same node can appear multiple times in EXPLAIN output). |
| `schema_*` TVFs | `deterministic` (for a given DB state); usually `isSet: true` with a clear primary key. |

This is a starter set. User-registered TVFs benefit from the same surface immediately.

### `LiteralNode` recognition helper

A small utility for TVF authors to use in their `TVFAdvertiseFn`s:

```typescript
function evaluateLiteralOperand(operand: ScalarPlanNode): SqlValue | undefined;
```

Returns the operand's literal value if it's a `LiteralNode`, otherwise undefined. This is the common case: `generate_series(1, 100)` has literal operands the author wants to read.

### Backward compatibility

`relationalAdvertisement` is entirely optional. Existing TVFs that don't declare it see no behavior change. The defaults match today's behavior (no special properties, `isSet: false`, no keys).

### Validation

`TableFunctionCallNode.computePhysical` cross-validates advertised properties:

- Advertised `keys` indices must be in range of `returnType.columns`.
- Advertised `monotonicOn` `attrId` must match an attribute produced by `getAttributes()`.
- Advertised `fds` indices must be in range.

Inconsistencies log a warning and the advertisement is ignored — TVF authors shouldn't be able to break correctness with a bad advertisement.

## Use cases enabled

- TVFs participate in FD propagation (the foundation ticket's machinery applies for free once the surface is in place).
- Monotonic LIMIT/OFFSET pushdown applies to TVFs that advertise `accessCapabilities.ordinalSeek` + `monotonicOn` (rare, but the door is open).
- Sort elimination above an ordered TVF: `ORDER BY` on the TVF's advertised ordering column becomes a no-op.
- Cardinality-based join algorithm selection picks better algorithms for small TVF outputs.
- DISTINCT elimination above a TVF that declares `isSet: true`.
- Constant folding can fold a TVF call whose `deterministic: true` and all-literal operands — once the relational constant folding subsystem opts in.

## Tests

- Unit test: a TVF with `relationalAdvertisement.keys = [[{index: 0}]]` propagates the key to the wrapping plan node, and DISTINCT elimination removes a DISTINCT above it.
- Unit test: `generate_series(1, 100)` plan node shows `estimatedRows: 100` in `query_plan()` output.
- Unit test: `ORDER BY value` above `generate_series` is recognized as redundant (matches the advertised monotonicOn).
- Negative test: an inconsistent advertisement (e.g. key index out of range) logs a warning and is ignored — query still runs correctly.
- Plan-shape test: FD-from-injective-projections applies to TVF output columns when a wrapping projection uses an injective expression.

## Documentation

- **docs/architecture.md** — extend the "User-Defined Functions" / TVF mention to note that TVFs can advertise relational properties; reference the optimizer doc.
- **docs/optimizer.md** — new section "TVF Property Declarations" covering the advertisement surface, the operand-aware `TVFAdvertiseFn` shape, the built-in annotations table, and the validation rules. Cross-reference from the FD framework section.
- **docs/usage.md** (if it covers TVF registration) — add an example of declaring properties on a user-registered TVF.

## Out of scope

- Advertising vtab-style `getBestAccessPlan` from a TVF — TVFs are not vtabs and this ticket doesn't change that boundary. If you need full access-plan negotiation, you want a vtab module, not a TVF.
- Dynamic advertisements that depend on the *runtime* values of arguments (e.g. `n` is a parameter, advertise estimatedRows = n at execution time). This requires re-planning per-execution which the parameterized statement cache already opposes. Compile-time advertisements based on literal operands are the goal here.
- Functional-dependency *inference* from TVF implementations. The implementer declares what's true; the engine doesn't try to derive it from the function body.
