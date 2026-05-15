---
description: Add a schema-polymorphic `EmptyRelationNode` (zero-row source carrying caller-supplied attributes) plus a small const-fold pass that recognizes provably-empty shapes — `Filter(x, lit-false)`, `Filter/Project/Sort/LimitOffset/Distinct(Empty, …)`, and inner/cross/semi/anti/outer joins with the relevant side empty — and short-circuits them to `EmptyRelationNode`. Switch the existing `rule-anti-join-fk-empty` to emit `EmptyRelationNode` directly so its IND-derived empty result is recognized by the rest of the plan instead of iterating the L child with a constant-false predicate.
files:
  - packages/quereus/src/planner/nodes/empty-relation-node.ts                   # NEW — schema-polymorphic empty source
  - packages/quereus/src/planner/nodes/plan-node-type.ts                        # add EmptyRelation enum entry
  - packages/quereus/src/runtime/emit/empty-relation.ts                         # NEW — yields nothing
  - packages/quereus/src/runtime/register.ts                                    # register emitter
  - packages/quereus/src/planner/rules/predicate/rule-empty-relation-folding.ts # NEW — const-fold pass (one function per host node type)
  - packages/quereus/src/planner/rules/subquery/rule-anti-join-fk-empty.ts      # emit EmptyRelationNode (was Filter(L, false))
  - packages/quereus/src/planner/optimizer.ts                                   # register fold rules at Structural priority 27 (after IND rules at 26)
  - packages/quereus/test/optimizer/empty-relation.spec.ts                      # NEW — unit + e2e tests
  - docs/optimizer.md                                                           # rewrite the "Filter(L, false) placeholder" note in the IND section + add an "Empty-relation folding" subsection
---

## Goal

The IND-existence work (`rule-anti-join-fk-empty`, Structural priority 26)
correctly folds `AntiJoin(L, R, p)` to `Filter(L, LiteralNode(false))` when the
FK→PK inclusion guarantees the anti-join is empty. This is sound but wasteful:
the runtime still iterates every row of `L` to evaluate `false`. The federated
win (parent `R` never accessed) is achieved; only the local L iteration is
wasted.

Two pieces ship together:

1. **`EmptyRelationNode`** — a relational primitive that produces zero rows of
   a caller-supplied attribute schema. Schema-polymorphic so callers
   (anti-join-empty, the fold pass) can hand it the surrounding node's
   `getAttributes()` / `getType()` directly, preserving attribute IDs and
   `RelationType` shape so consumers above the empty subtree keep working.

2. **`rule-empty-relation-folding`** — a const-fold pass recognizing
   provably-empty shapes and replacing them with `EmptyRelationNode`. Runs in
   the Structural pass at priority 27 (just after the IND rules at 26) so it
   cleans up after anti-join-empty and any other producer of literal-false
   filters or empty-relation subtrees.

## Architecture

### `EmptyRelationNode` (`planner/nodes/empty-relation-node.ts`)

```ts
import { PlanNodeType } from './plan-node-type.js';
import {
  PlanNode, type ZeroAryRelationalNode, type Attribute, type PhysicalProperties
} from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

/**
 * Schema-polymorphic empty relation: produces zero rows of the given
 * attribute schema. Used by const-folding rules that prove a subtree is
 * empty (e.g. `Filter(L, false)`, `InnerJoin(Empty, R)`). Distinct from
 * `EmptyResultNode`, which is tied to a `TableReferenceNode` and represents
 * an empty *table access*; this node is detached from any specific source.
 */
export class EmptyRelationNode extends PlanNode implements ZeroAryRelationalNode {
  override readonly nodeType = PlanNodeType.EmptyRelation;

  constructor(
    scope: Scope,
    public readonly attributes: readonly Attribute[],
    public readonly relationType: RelationType,
    estimatedCostOverride?: number,
  ) {
    super(scope, estimatedCostOverride ?? 0.001);
  }

  getType(): RelationType { return this.relationType; }
  getAttributes(): readonly Attribute[] { return this.attributes; }
  getChildren(): readonly [] { return []; }
  getRelations(): readonly [] { return []; }

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    if (newChildren.length !== 0) {
      quereusError(`EmptyRelationNode expects 0 children, got ${newChildren.length}`, StatusCode.INTERNAL);
    }
    return this;
  }

  get estimatedRows(): number { return 0; }

  override computePhysical(): Partial<PhysicalProperties> {
    return { estimatedRows: 0, ordering: undefined };
  }

  override toString(): string {
    return `EMPTY RELATION (${this.attributes.length} cols)`;
  }

  override getLogicalAttributes(): Record<string, unknown> {
    return {
      numColumns: this.attributes.length,
      columnNames: this.attributes.map(a => a.name),
    };
  }
}
```

Notes:

- Boundary contract: the constructor takes the *exact* `Attribute[]` and
  `RelationType` the surrounding node would have produced. The fold rules
  populate these from the host node's `getAttributes()` / `getType()` so
  attribute IDs above the empty subtree remain stable.
- We deliberately don't merge with the existing `EmptyResultNode` (which is
  `UnaryRelationalNode` wrapping a `TableReferenceNode`). The two have
  different invariants — `EmptyResultNode` keeps a live table-schema link for
  EXPLAIN; `EmptyRelationNode` is unmoored from any table.
- `computePhysical` returns `estimatedRows: 0`. We don't fabricate FDs / ECs /
  bindings — a zero-row relation trivially satisfies any constraint, but
  emitting `∅ → all_cols` from a synthetic 0-row source would mislead
  downstream rules into thinking they've seen a constant-yielding subquery.
  Cost wins come from estimatedRows, which is enough.

### Emitter (`runtime/emit/empty-relation.ts`)

```ts
import type { EmptyRelationNode } from '../../planner/nodes/empty-relation-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';

export function emitEmptyRelation(_plan: EmptyRelationNode, _ctx: EmissionContext): Instruction {
  async function* run(_rctx: RuntimeContext): AsyncIterable<Row> {
    // Zero rows.
  }
  return { params: [], run, note: 'empty_relation' };
}
```

Register in `runtime/register.ts` alongside `EmptyResult`:

```ts
registerEmitter(PlanNodeType.EmptyRelation, emitEmptyRelation as EmitterFunc);
```

### Const-fold pass (`planner/rules/predicate/rule-empty-relation-folding.ts`)

One file, multiple exported rule functions — one per host node type — so each
gets its own `RuleHandle` registration. All run in the Structural pass at
priority 27 (after IND rules at 26 and other Structural folds; lower numbers
run first).

Recognized shapes (canonical: `E = EmptyRelationNode`):

| Host shape                             | Rewrite                                              | Notes |
|----------------------------------------|------------------------------------------------------|-------|
| `Filter(x, lit-false / lit-null / lit-0)` | `EmptyRelationNode(x.getAttributes(), x.getType())` | "lit-false" = `LiteralNode` whose `expression.value` is `false`, `0`, `0n`, or `null`. WHERE-truthiness: false/NULL/0 all reject. |
| `Filter(E, _)`                          | `E` (boundary already matches)                       | |
| `Project(E, projections)`               | `EmptyRelationNode(project.getAttributes(), project.getType())` | Uses Project's own attribute IDs so callers above keep working. |
| `Sort(E, _)`                            | `E`                                                  | Schema unchanged. |
| `LimitOffset(E, _)`                     | `E`                                                  | Schema unchanged. |
| `Distinct(E)`                           | `E`                                                  | Schema unchanged. |
| `Join(E, R, inner | cross)`             | `EmptyRelationNode(join.getAttributes(), join.getType())` | |
| `Join(L, E, inner | cross)`             | `EmptyRelationNode(join.getAttributes(), join.getType())` | |
| `Join(E, R, left)`                      | `EmptyRelationNode(join.getAttributes(), join.getType())` | Empty left side → no driving rows. |
| `Join(L, E, right)`                     | `EmptyRelationNode(join.getAttributes(), join.getType())` | Symmetric to LEFT. |
| `Join(E, _, semi | anti)`               | `EmptyRelationNode(join.getAttributes(), join.getType())` | SEMI/ANTI drive from left only. |
| `Join(L, E, semi)`                      | `EmptyRelationNode(join.getAttributes(), join.getType())` | No matches → no rows. |
| `Join(_, _, full)` with **both** empty  | `EmptyRelationNode(join.getAttributes(), join.getType())` | A single empty side under FULL still null-pads — don't fold. |

Deliberately NOT folded (sound reasons):

- `Join(L, E, left)` — returns L with null-padded right; `E` doesn't make output empty.
- `Join(E, R, right)` — symmetric.
- `Join(L | _, E, anti)` — anti-join with empty right returns *all* of L.
- One-side-empty FULL — still emits null-padded rows for the non-empty side.

Each rule has the shape (see existing rules like `rule-filter-merge.ts` for
the template):

```ts
import type { PlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { FilterNode } from '../../nodes/filter.js';
import { ProjectNode } from '../../nodes/project-node.js';
import { SortNode } from '../../nodes/sort.js';
import { LimitOffsetNode } from '../../nodes/limit-offset.js';
import { DistinctNode } from '../../nodes/distinct-node.js';
import { JoinNode } from '../../nodes/join-node.js';
import { LiteralNode } from '../../nodes/scalar.js';
import { EmptyRelationNode } from '../../nodes/empty-relation-node.js';

function isEmpty(node: PlanNode): node is EmptyRelationNode {
  return node instanceof EmptyRelationNode;
}

function isLiteralFalsy(node: PlanNode): boolean {
  if (!(node instanceof LiteralNode)) return false;
  const v = node.expression.value;
  // WHERE-clause truthiness: false / NULL / 0 / 0n / '' would all reject.
  // Conservatively cover the canonical "no rows" literals; '' and unusual
  // coercions are left out (and produced by the AST/literal pipeline only via
  // explicit `where ''`, which is uncommon).
  return v === false || v === null || v === 0 || v === 0n;
}

export function ruleFilterFoldEmpty(node: PlanNode, _ctx: OptContext): PlanNode | null {
  if (!(node instanceof FilterNode)) return null;
  if (isEmpty(node.source)) {
    return node.source; // schema preserved by Filter; Empty already has the same attrs.
  }
  if (isLiteralFalsy(node.predicate)) {
    return new EmptyRelationNode(node.scope, node.getAttributes(), node.getType());
  }
  return null;
}

export function ruleProjectFoldEmpty(node: PlanNode, _ctx: OptContext): PlanNode | null {
  if (!(node instanceof ProjectNode)) return null;
  if (!isEmpty(node.source)) return null;
  return new EmptyRelationNode(node.scope, node.getAttributes(), node.getType());
}

// …similar small functions for SortFoldEmpty, LimitOffsetFoldEmpty,
// DistinctFoldEmpty, JoinFoldEmpty.

export function ruleJoinFoldEmpty(node: PlanNode, _ctx: OptContext): PlanNode | null {
  if (!(node instanceof JoinNode)) return null;
  const leftEmpty = isEmpty(node.left);
  const rightEmpty = isEmpty(node.right);
  if (!leftEmpty && !rightEmpty) return null;

  switch (node.joinType) {
    case 'inner':
    case 'cross':
      if (leftEmpty || rightEmpty) break;
      return null;
    case 'left':
      if (leftEmpty) break;
      return null;
    case 'right':
      if (rightEmpty) break;
      return null;
    case 'full':
      if (leftEmpty && rightEmpty) break;
      return null;
    case 'semi':
      if (leftEmpty || rightEmpty) break;
      return null;
    case 'anti':
      if (leftEmpty) break;
      return null; // anti(L, Empty) → L, not empty; don't fold here.
    default:
      return null;
  }
  return new EmptyRelationNode(node.scope, node.getAttributes(), node.getType());
}
```

Registration in `planner/optimizer.ts` (mirroring the IND rule pattern at 26):

```ts
this.passManager.addRuleToPass(PassId.Structural, {
  id: 'fold-filter-empty',
  nodeType: PlanNodeType.Filter,
  phase: 'rewrite',
  fn: ruleFilterFoldEmpty,
  priority: 27,
});
this.passManager.addRuleToPass(PassId.Structural, {
  id: 'fold-project-empty',
  nodeType: PlanNodeType.Project,
  phase: 'rewrite',
  fn: ruleProjectFoldEmpty,
  priority: 27,
});
this.passManager.addRuleToPass(PassId.Structural, {
  id: 'fold-sort-empty',
  nodeType: PlanNodeType.Sort,
  phase: 'rewrite',
  fn: ruleSortFoldEmpty,
  priority: 27,
});
this.passManager.addRuleToPass(PassId.Structural, {
  id: 'fold-limit-empty',
  nodeType: PlanNodeType.LimitOffset,
  phase: 'rewrite',
  fn: ruleLimitOffsetFoldEmpty,
  priority: 27,
});
this.passManager.addRuleToPass(PassId.Structural, {
  id: 'fold-distinct-empty',
  nodeType: PlanNodeType.Distinct,
  phase: 'rewrite',
  fn: ruleDistinctFoldEmpty,
  priority: 27,
});
this.passManager.addRuleToPass(PassId.Structural, {
  id: 'fold-join-empty',
  nodeType: PlanNodeType.Join,
  phase: 'rewrite',
  fn: ruleJoinFoldEmpty,
  priority: 27,
});
```

The Structural pass loops to a fixed point (see `framework/pass.ts`), so each
fold can cascade: `Filter(Sort(Filter(L, false)))` collapses through
`Filter(Sort(Empty)) → Filter(Empty) → Empty` across iterations.

### Anti-join rule switch (`planner/rules/subquery/rule-anti-join-fk-empty.ts`)

Replace the existing tail:

```ts
const literalFalse = new LiteralNode(node.scope, { type: 'literal', value: false });
return new FilterNode(node.scope, node.left, literalFalse);
```

with:

```ts
return new EmptyRelationNode(node.scope, node.left.getAttributes(), node.left.getType());
```

The boundary contract holds: the anti-join's output schema is L's schema
(SEMI/ANTI take left columns only — see `combineJoinKeys` /
`buildJoinAttributes`), so using `node.left.getAttributes()` /
`node.left.getType()` preserves the attribute IDs the parent would see today.
Remove the now-stale "Why not a dedicated EmptyRelationNode" paragraph from
the rule's header comment.

## Tests (`test/optimizer/empty-relation.spec.ts`)

Mirror the style of `ind-existence.spec.ts` (query the `query_plan` vtab to
assert structural rewrites; query results for semantic correctness).

### Plan-shape tests

For each, scan the plan and assert (a) at least one `EMPTYRELATION` op
appears, (b) the wrapped subtree is gone:

- `select * from t where false` → plan contains EmptyRelation, no SeqScan.
- `select * from t where null` → same.
- `select x from t where 1=2` *after* `predicate-contradiction` lands: not
  this ticket's concern — verify only the `lit-false` shape here. Add a TODO
  in the spec referencing ticket
  `2-optimizer-predicate-contradiction-detection`.
- `select a.x from t a where not exists (select 1 from t2 b where b.id = a.fk_id)`
  with the FK schema from `ind-existence.spec.ts` — assert plan contains
  EmptyRelation, no Filter, no SeqScan of `t`.
- `select * from t join (select * from t2 where false) z on t.k = z.k`
  (inner) → assert plan is EmptyRelation; no join, no SeqScan of `t`, no
  SeqScan of `t2`.
- `select * from (select * from t where false) order by x limit 5` →
  EmptyRelation only.
- Project preserves attribute IDs at the boundary: build the same query with
  `select x as y from t where false` and confirm the EXPLAIN output column
  name is `y` (proves Project's attribute IDs were lifted onto the Empty
  node).

### Negative tests (must NOT fold)

- `select * from t left join (select * from t2 where false) z on t.k = z.k` →
  plan still contains the LEFT JOIN; result has all `t` rows with NULL right.
- `select * from t right join (select * from t2 where false) z on t.k = z.k`
  → EmptyRelation (right empty under RIGHT JOIN drives the output).
- `select * from t full outer join (select * from t2 where false) z on t.k = z.k`
  → still a FULL JOIN; result has all `t` rows null-padded.
- `select * from t where not exists (select 1 from (select * from t2 where false) z where z.k = t.k)`
  — `NOT EXISTS` over the empty right → returns all of `t` (anti-join with
  empty right is L, not empty). Fold rule must abstain on `anti` joins with
  empty right.

### Result tests

End-to-end correctness via `db.eval`:

- `select count(*) from t where false` → `[ { count: 0 } ]`.
- Original `ind-existence.spec.ts` "folds NOT EXISTS over a non-null FK"
  case continues to pass — the result is still empty, and now the plan
  contains `EmptyRelation` instead of `Filter(L, false)`. Update the assertion
  there to look for `EMPTYRELATION` op as the new canonical shape (and drop
  the implicit assumption that `Filter` survives). Keep the join-count and
  parent-not-referenced assertions.

## Documentation

`docs/optimizer.md`:

- Replace the closing paragraph at lines 1375 ("The anti-join-to-empty rewrite
  emits `Filter(L, LiteralNode(false))`…") with a forward reference to the
  new `EmptyRelationNode` and the fold pass. New text along the lines of:
  > The anti-join-to-empty rewrite emits `EmptyRelationNode` carrying L's
  > attribute IDs and `RelationType`; downstream the const-fold pass
  > (Structural priority 27) cascades that emptiness up through Filter /
  > Project / Sort / LimitOffset / Distinct / inner-or-cross-or-semi joins.
- Add a new subsection "Empty-relation folding" near the existing IND
  paragraph, describing the recognized shapes (the table above) and the
  attribute-ID preservation contract.
- Update the "EmptyResultNode" line at 1692 to mention the sibling
  `EmptyRelationNode` and the distinction (table-access-bound vs detached).

## Validation

Run from the repo root after each phase:

```sh
yarn workspace @quereus/quereus run build 2>&1 | tee /tmp/empty-relation-build.log
yarn workspace @quereus/quereus run lint 2>&1 | tee /tmp/empty-relation-lint.log
yarn workspace @quereus/quereus test 2>&1 | tee /tmp/empty-relation-test.log
```

Targeted spec for iteration:

```sh
yarn workspace @quereus/quereus test --grep 'empty-relation' 2>&1 | tee /tmp/empty-relation-spec.log
yarn workspace @quereus/quereus test --grep 'IND-driven existence folding' 2>&1 | tee /tmp/ind-existence.log
```

Watch for regressions in:
- `ind-existence.spec.ts` (anti-join-fk-empty assertions need updating to the
  new plan shape).
- `optimizer-predicate-contradiction-detection` is a downstream consumer
  (already lists this ticket as prereq) — no changes needed here, just keep
  the contract stable (emit `EmptyRelationNode`, not `Filter(L, false)`).

## TODO

Phase 1 — node + emitter
- Add `EmptyRelation` to `PlanNodeType` enum.
- Create `planner/nodes/empty-relation-node.ts` with the class above; ensure
  it implements `ZeroAryRelationalNode`.
- Create `runtime/emit/empty-relation.ts` that yields nothing.
- Register the emitter in `runtime/register.ts` next to `emitEmptyResult`.
- Build + quick unit test instantiating a node and emitting it via the
  existing test harness to confirm zero rows.

Phase 2 — switch anti-join rule
- In `rule-anti-join-fk-empty.ts`, replace the `Filter(L, false)` tail with
  `new EmptyRelationNode(node.scope, node.left.getAttributes(), node.left.getType())`.
- Update the header comment to remove the "Why not a dedicated
  EmptyRelationNode" paragraph and point to the new fold pass.
- Update `ind-existence.spec.ts` plan-shape assertions to look for
  `EMPTYRELATION` op (keep the result assertions).

Phase 3 — const-fold rules
- Create `planner/rules/predicate/rule-empty-relation-folding.ts` with one
  exported function per host node type (Filter / Project / Sort / LimitOffset
  / Distinct / Join) plus the small `isEmpty` / `isLiteralFalsy` helpers.
- Register all six rules in `planner/optimizer.ts` at Structural priority 27.

Phase 4 — tests
- Create `test/optimizer/empty-relation.spec.ts` covering the matrix above
  (plan-shape + result tests, including the LEFT/RIGHT/FULL/ANTI negatives).
- Confirm `yarn workspace @quereus/quereus test` is clean.

Phase 5 — docs
- Rewrite the lines in `docs/optimizer.md` referenced above and add the new
  "Empty-relation folding" subsection.
- Refresh the EmptyResultNode bullet to mention the sibling node.
