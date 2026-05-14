---
description: Add a `relationalAdvertisement` surface to TableValuedFunctionSchema so TVF authors can declare physical properties (FDs, ordering, monotonicOn, estimatedRows, isSet, keys, access capabilities, determinism); wire `TableFunctionCallNode.computePhysical` to consume it; annotate built-in TVFs that have learnable properties.
prereq: fd-property-foundation
files:
  - packages/quereus/src/schema/function.ts
  - packages/quereus/src/planner/nodes/table-function-call.ts
  - packages/quereus/src/func/registration.ts
  - packages/quereus/src/func/builtins/generation.ts
  - packages/quereus/src/func/builtins/json-tvf.ts
  - packages/quereus/src/func/builtins/explain.ts
  - packages/quereus/src/func/builtins/schema.ts
  - packages/quereus/test/planner/tvf-physical-properties.spec.ts (new)
  - docs/optimizer.md
  - docs/architecture.md
---

## Goal

Today `TableFunctionCallNode.getType()` returns the schema's `RelationType` verbatim and inherits the default `PhysicalProperties` — so even when a TVF produces ordered, unique, set-valued output, the optimizer sees nothing. This locks TVFs out of FD propagation, sort elimination, DISTINCT elimination, cardinality-aware planning, etc.

Add a single, optional `relationalAdvertisement` field on `TableValuedFunctionSchema` that carries the physical / relational facts a TVF author wants to advertise. Each facet may be a static value or a function of the call's operand expressions (so `generate_series(1, 100)` can advertise `estimatedRows: 100` while `generate_series(1, ?)` cannot). Wire `TableFunctionCallNode` to consume it through the standard `computePhysical` / `getType` paths and validate the declarations to prevent broken advertisements from poisoning the optimizer.

## Architecture

### Schema surface (`packages/quereus/src/schema/function.ts`)

Add a new exported type and extend `TableValuedFunctionSchema`:

```typescript
import type { ScalarPlanNode } from '../planner/nodes/plan-node.js';  // forward type-only — break circular import via type-only `import type`
import type { ConstantBinding, FunctionalDependency, MonotonicOnInfo, PhysicalProperties } from '../planner/nodes/plan-node.js';
import type { ColRef } from '../common/datatype.js';

/**
 * Function form for parameter-dependent advertisements. Receives the call
 * operands so the implementation can read literal values, parameter slots, or
 * operand types. Return `undefined` to decline (no property advertised).
 */
export type TVFAdvertiseFn<T> = (
  operands: ReadonlyArray<ScalarPlanNode>,
  schema: TableValuedFunctionSchema,
) => T | undefined;

/**
 * Optional advertisement of a TVF's relational and physical properties.
 * Each field may be a static value or a function of the call's operands.
 */
export interface TVFAdvertisement {
  isSet?: boolean | TVFAdvertiseFn<boolean>;
  keys?: ReadonlyArray<ReadonlyArray<ColRef>> | TVFAdvertiseFn<ReadonlyArray<ReadonlyArray<ColRef>>>;
  fds?: ReadonlyArray<FunctionalDependency> | TVFAdvertiseFn<ReadonlyArray<FunctionalDependency>>;
  equivClasses?: ReadonlyArray<ReadonlyArray<number>> | TVFAdvertiseFn<ReadonlyArray<ReadonlyArray<number>>>;
  ordering?: ReadonlyArray<{ column: number; desc: boolean }> | TVFAdvertiseFn<ReadonlyArray<{ column: number; desc: boolean }>>;
  monotonicOn?: ReadonlyArray<MonotonicOnInfo> | TVFAdvertiseFn<ReadonlyArray<MonotonicOnInfo>>;
  constantBindings?: ReadonlyArray<ConstantBinding> | TVFAdvertiseFn<ReadonlyArray<ConstantBinding>>;
  estimatedRows?: number | TVFAdvertiseFn<number>;
  accessCapabilities?: PhysicalProperties['accessCapabilities'];
  deterministic?: boolean;
  readonly?: boolean;
  idempotent?: boolean;
}

export interface TableValuedFunctionSchema extends BaseFunctionSchema {
  returnType: RelationType;
  implementation: TableValuedFunc | IntegratedTableValuedFunc;
  isIntegrated?: boolean;
  /** Optional advertisement of relational/physical properties. */
  relationalAdvertisement?: TVFAdvertisement;
}
```

Watch the import direction: `schema/function.ts` is imported by planner nodes, so introduce the planner-node imports with `import type` only. If TypeScript still flags a cycle, push the `TVFAdvertisement` shape into a sibling file (`schema/tvf-advertisement.ts`) — but keep both types exported from `schema/function.ts` for ergonomics.

### Resolution helper

Add `resolveAdvertisement` next to the schema definitions (or in a small new `schema/tvf-advertisement.ts`):

```typescript
export function resolveAdvertisement<T>(
  spec: T | TVFAdvertiseFn<T> | undefined,
  operands: ReadonlyArray<ScalarPlanNode>,
  schema: TableValuedFunctionSchema,
): T | undefined {
  if (spec === undefined) return undefined;
  if (typeof spec === 'function') {
    try {
      return (spec as TVFAdvertiseFn<T>)(operands, schema);
    } catch {
      // Bad advertisement closure must never break planning.
      return undefined;
    }
  }
  return spec;
}
```

### Literal-operand helper

Add a small public utility — colocate with the resolver:

```typescript
export function evaluateLiteralOperand(operand: ScalarPlanNode): SqlValue | undefined;
```

Implementation: returns `operand.value` when `operand instanceof LiteralNode`, otherwise `undefined`. Keep it tolerant — it is used inside `TVFAdvertiseFn` closures whose return is allowed to be `undefined`.

### Registration ergonomics (`packages/quereus/src/func/registration.ts`)

Extend `TableValuedFuncOptions` with an optional `relationalAdvertisement: TVFAdvertisement`, and forward it on both `createTableValuedFunction` and `createIntegratedTableValuedFunction`. No default — absence means "no advertisement," preserving today's behavior.

### Plan-node wiring (`packages/quereus/src/planner/nodes/table-function-call.ts`)

Extend `TableFunctionCallNode`:

1. `getType()` — when `relationalAdvertisement` is present, build a new `RelationType` overriding `isSet` and `keys` from the resolved advertisement (fall back to `returnType.isSet` / `returnType.keys` when undefined). Don't mutate `functionSchema.returnType`. Use the existing attributes cache for stability; do not invalidate it on advertisement-only changes.

2. New `override computePhysical(): Partial<PhysicalProperties>`. (No children — operands are scalar, so it does not take `childrenPhysical`.) Pseudocode:

```typescript
override computePhysical(): Partial<PhysicalProperties> {
  if (!isTableValuedFunctionSchema(this.functionSchema)) return {};
  const adv = this.functionSchema.relationalAdvertisement;
  const out: Partial<PhysicalProperties> = {
    // Reflect FunctionFlags.DETERMINISTIC by default.
    deterministic: (this.functionSchema.flags & FunctionFlags.DETERMINISTIC) !== 0,
    readonly: true,
    idempotent: true,
  };
  if (!adv) return out;

  const ops = this.operands;
  const schema = this.functionSchema;

  // Per-field resolution + validation. Skip a field on validation failure;
  // log a single warning via the optimizer log channel.
  const colCount = this.functionSchema.returnType.columns.length;
  const attrIds = new Set(this.getAttributes().map(a => a.id));

  const keys = resolveAdvertisement(adv.keys, ops, schema);
  if (keys && validateKeys(keys, colCount)) {
    out.uniqueKeys = keys.map(k => k.map(c => c.index));
  }

  const fds = resolveAdvertisement(adv.fds, ops, schema);
  if (fds && validateFds(fds, colCount)) out.fds = fds;

  const equivClasses = resolveAdvertisement(adv.equivClasses, ops, schema);
  if (equivClasses && validateEcs(equivClasses, colCount)) out.equivClasses = equivClasses;

  const ordering = resolveAdvertisement(adv.ordering, ops, schema);
  if (ordering && validateOrdering(ordering, colCount)) out.ordering = [...ordering];

  const monotonicOn = resolveAdvertisement(adv.monotonicOn, ops, schema);
  if (monotonicOn && validateMonotonicOn(monotonicOn, attrIds)) out.monotonicOn = monotonicOn;

  const constantBindings = resolveAdvertisement(adv.constantBindings, ops, schema);
  if (constantBindings && validateBindings(constantBindings, colCount)) out.constantBindings = constantBindings;

  const estimatedRows = resolveAdvertisement(adv.estimatedRows, ops, schema);
  if (typeof estimatedRows === 'number' && estimatedRows >= 0) out.estimatedRows = estimatedRows;

  if (adv.accessCapabilities) out.accessCapabilities = adv.accessCapabilities;
  if (adv.deterministic !== undefined) out.deterministic = adv.deterministic;
  if (adv.readonly !== undefined) out.readonly = adv.readonly;
  if (adv.idempotent !== undefined) out.idempotent = adv.idempotent;

  return out;
}
```

3. Update the `estimatedRows` getter on `TableFunctionCallNode` to consult `this.physical.estimatedRows` first, falling back to today's 10-row default. (PlanNode caches physical lazily; using the getter is fine.) Note: `physical` may invoke `computePhysical` which re-reads operands — operands are constructor inputs and stable.

4. Validation helpers — colocate as private functions in the same file. Each returns `true` on success, otherwise logs once via the existing `createLogger('quereus:planner:tvf')` channel and returns `false`. Reuse the project's `createLogger` pattern (see other planner nodes for examples).

   - `validateKeys`: every `ColRef.index` is in `[0, colCount)`.
   - `validateFds`: every determinant/dependent index in range; dependents non-empty.
   - `validateEcs`: every index in range; every class has ≥ 2 members.
   - `validateOrdering`: every column index in range; no duplicate columns.
   - `validateMonotonicOn`: every `attrId` is present in this node's attribute set.
   - `validateBindings`: every attr index in range.

### Built-in TVF annotations

Starter set — see the plan's table. Each lives next to its schema definition.

`generate_series` (`generation.ts`): the second operand is the inclusive end. The output is `value` (col 0) which is strictly monotone:

```typescript
relationalAdvertisement: {
  isSet: true,
  keys: [[{ index: 0 }]],
  ordering: [{ column: 0, desc: false }],          // step is always +1 today
  monotonicOn: (operands, _schema) => {
    // attrId is owned by the TableFunctionCallNode; computePhysical re-grounds
    // monotonicOn against the live attribute set, so just return `undefined`
    // here — the node-level wiring promotes the advertised ordering to
    // monotonicOn when the schema also declares it. Leave as a future
    // extension. (See "Open mini-question" below.)
    return undefined;
  },
  estimatedRows: (operands) => {
    const start = evaluateLiteralOperand(operands[0]);
    const end = evaluateLiteralOperand(operands[1]);
    if (typeof start === 'number' && typeof end === 'number' && end >= start) {
      return end - start + 1;
    }
    if (typeof start === 'bigint' && typeof end === 'bigint' && end >= start) {
      return Number(end - start) + 1;
    }
    return undefined;
  },
  deterministic: true,
}
```

`json_each` (`json-tvf.ts`): the `key` column (index 0) is unique within the result for an object input — but not for an array input where keys are integer indices 0..n-1 (still unique). Either case yields uniqueness on `key`. Declare `isSet: true` and `keys: [[{ index: 0 }]]`. Also annotate `deterministic: true` (already implicit via flags, but explicit doesn't hurt).

`json_tree` (`json-tvf.ts`): the `id` column (index 4) is unique per emitted row (assigned via a counter). Declare `isSet: true`, `keys: [[{ index: 4 }]]`, `deterministic: true`.

`query_plan` (`explain.ts`): the `id` column (index 0) is the assigned `nodeId` and is unique. Declare `isSet: true`, `keys: [[{ index: 0 }]]`, `deterministic: true`.

`schema_*` TVFs (`schema.ts`): mark `deterministic: false` is already implicit. For the ones where a clear key is obvious:
- `function_info`: composite key `(name, num_args)`. Declare `keys: [[{ index: 0 }, { index: 1 }]]`.
- `index_info`: composite key `(index_name, seq)`.
- `foreign_key_info`: composite key `(id, seq)`.
- `unique_constraint_info`: composite key `(id, seq)`.
- `check_constraint_info`: `keys: [[{ index: 0 }]]`.
- `table_info`: `keys: [[{ index: 0 }]]` (cid).
- `schema`: skip (multi-rowing — the `(schema, type, name)` triple is unique but not worth the gain).
- `assertion_info`: `keys: [[{ index: 0 }]]` (name).

Skip non-deterministic / trace TVFs (`execution_trace`, `row_trace`, `stack_trace`, `scheduler_program`, `schema_size`, `explain_assertion`) — either no obvious key or non-deterministic.

### Backward compatibility

`relationalAdvertisement` is optional. Schemas without it produce the same `getType()` and physical defaults as today. Existing TVFs (third-party / plugin) keep working unchanged.

### Open mini-question (proceed with default)

`monotonicOn` advertised via the schema requires a stable `attrId`, but `attrId`s are minted by the `TableFunctionCallNode` per call (see `attributesCache`). Two options:

- **(chosen) Synthesize monotonicOn at the node from advertised `ordering`** when `keys` covers the leading ordering column and the schema declares `strict: true` via an extra advertisement field — e.g. `monotonicOnColumns?: ReadonlyArray<{ column: number; direction: 'asc'|'desc'; strict?: boolean }>`. The node then translates `column` → live `attrId` in `computePhysical`. This keeps the schema author talking in column indices everywhere.
- (rejected) Have the schema return `MonotonicOnInfo` with placeholder `attrId` that the node rewrites — error-prone.

Implement option (chosen): add `monotonicOnColumns` to `TVFAdvertisement` (alongside `monotonicOn` for niche cases where the author already has the attrId). The plan's `monotonicOn` field stays for completeness but for built-in annotations we use `monotonicOnColumns`. Update the validation/translation accordingly.

For `generate_series`: `monotonicOnColumns: [{ column: 0, direction: 'asc', strict: true }]`.

### Tests (`packages/quereus/test/planner/tvf-physical-properties.spec.ts` — new)

Use the pattern in `test/optimizer/monotonic-on.spec.ts` for reading `physical` from `query_plan(?)`. Cases:

- `generate_series(1, 100)` — physical row for the TableFunctionCall node has `uniqueKeys: [[0]]`, `ordering: [{column:0,desc:false}]`, `estimatedRows: 100`, `monotonicOn: [{attrId, strict:true, direction:'asc'}]`. (Fetch `attrId` from the node's attributes via `properties` JSON.)
- `generate_series(1, ?)` — same as above except `estimatedRows` is absent (or falls back to default). Verifies the resolver tolerates non-literal operands.
- `json_each('[1,2,3]')` — `getType().isSet === true`, `uniqueKeys: [[0]]`.
- DISTINCT elimination: `SELECT DISTINCT key FROM json_each('{"a":1,"b":2}')` planning result does NOT contain a DistinctNode. Use the rule trace or the plan-node-traversal pattern to assert.
- Sort elimination: `SELECT * FROM generate_series(1, 10) ORDER BY value` planning result does NOT contain a SortNode. (Confirm `rule-orderby-monotonic-elimination` already covers this when ordering+keys are advertised — if not, leave a TODO note.)
- Negative: a synthetic TVF registered in-test declares `keys: [[{index: 99}]]` (out-of-range). Assert (a) query still runs, (b) the node's `physical.uniqueKeys` is absent, (c) a single warning was emitted (capture via spy on logger if practical; otherwise just verify property absence).
- FD-from-injective-projections (carried from the plan): `SELECT value + 1 AS v FROM generate_series(1, 5)` — assert that the projected `v` is in `uniqueKeys` on the Project node (proving the FD foundation flows through to TVF outputs).

### Documentation

- `packages/quereus/docs/optimizer.md` — new H2 section "TVF property declarations." Cover: the advertisement surface (each field, static vs `TVFAdvertiseFn`), the `monotonicOnColumns` shape and why it exists, the `evaluateLiteralOperand` helper, the validation rules (and that failed validation is a no-op + warning), and the built-in annotation table. Cross-link from the FD framework section if one exists; otherwise add a short forward-reference paragraph.
- `packages/quereus/docs/architecture.md` — in whatever section covers TVF registration / function schema (search for "table-valued" / `createTableValuedFunction`), add a sentence noting the optional advertisement and linking to optimizer.md.
- `packages/quereus/docs/usage.md` — if (and only if) it already covers TVF registration, add a short example registering a user TVF with `relationalAdvertisement: { keys: [[{index: 0}]], isSet: true }`. If usage.md has no existing TVF section, skip — don't grow a new one.

### Out of scope (per plan)

- vtab-style `getBestAccessPlan` from a TVF.
- Runtime parameter-dependent advertisements.
- Auto-inferring advertisements from the JS implementation body.

## TODO

Phase 1 — surface + wiring

- Add `TVFAdvertiseFn`, `TVFAdvertisement`, and the `relationalAdvertisement` field to `TableValuedFunctionSchema` in `schema/function.ts` (use `import type` for planner-node references to avoid circular imports — split into a sibling file only if TS still complains).
- Add `resolveAdvertisement` and `evaluateLiteralOperand` helpers (colocate or sibling file).
- Extend `TableValuedFuncOptions` in `func/registration.ts` and forward `relationalAdvertisement` on both `createTableValuedFunction` and `createIntegratedTableValuedFunction`.
- Implement `getType()` override and `computePhysical()` in `TableFunctionCallNode`. Promote advertised `monotonicOnColumns` to `monotonicOn` by looking up live `attrId`s in `getAttributes()`.
- Update `TableFunctionCallNode.estimatedRows` to prefer `this.physical.estimatedRows`.
- Implement the per-field validators with a single logger channel; bad advertisements are dropped silently except for a single warning.

Phase 2 — built-in annotations

- Annotate `generate_series` (`generation.ts`) with `isSet`, `keys`, `ordering`, `monotonicOnColumns`, `estimatedRows` (literal-aware), `deterministic`.
- Annotate `json_each` and `json_tree` (`json-tvf.ts`) with `isSet`, `keys`, `deterministic`.
- Annotate `query_plan` (`explain.ts`) with `isSet`, `keys`, `deterministic`.
- Annotate the listed `schema.ts` introspection TVFs with `keys` (and `isSet` where safe).

Phase 3 — tests

- Create `packages/quereus/test/planner/tvf-physical-properties.spec.ts` with the cases listed above.
- Sanity-check sort elimination and DISTINCT elimination interactions; if a rule does not yet pick up the new advertisement, add a small TODO note in the spec (don't expand scope here).
- Run `yarn build` and `yarn test` (root) and `yarn workspace @quereus/quereus run lint`. Stream all output (`2>&1 | tee`).

Phase 4 — docs

- Update `packages/quereus/docs/optimizer.md` with the new TVF property declarations section.
- Update `packages/quereus/docs/architecture.md` with a sentence + cross-reference.
- Skip `usage.md` unless it already has a TVF section.
