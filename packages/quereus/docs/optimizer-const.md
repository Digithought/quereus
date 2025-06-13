# Titan Optimizer – Constant Folding & Constant-Dependency Resolution

This document describes the **design, data-flow, and implementation guidance** for the constant-folding stage of the Titan optimizer.  It is written for engineers who are already familiar with the main `README.md`, `docs/runtime.md`, and `docs/titan-optimizer.md`.  The goal is to make any scalar (and later, relational) sub-tree that is *functionally* constant collapse to a `LiteralNode` or a pre-materialised `ValuesNode`, using **one single evaluation engine** – the existing runtime.

---
## 1. Definitions

| Term            | Meaning                                                                                     |
|-----------------|---------------------------------------------------------------------------------------------|
| *pure*          | The node never mutates database or VM state.                                                |
| *deterministic* | Given identical inputs the node always returns the same output.                             |
| *functional*    | `pure` **and** `deterministic`.  A functional node is safe to fold.                         |

`functional` is captured on `PhysicalProperties`:
```ts
interface PhysicalProperties {
  deterministic: boolean;   // already present
  readonly: boolean;        // already present
  functional?: boolean;     // omitted = deterministic && readonly
}
```
A helper `isFunctional(node)` returns the effective value.

---
## 2. ConstInfo – bottom-up classification

During a single post-order DFS every `PlanNode` is assigned a `ConstInfo`:
```ts
/* not exported – internal to folding pass */
interface ConstInfoConst { kind: 'const'; value: SqlValue; }
interface ConstInfoDep   { kind: 'dep';   deps: Set<AttributeId>; }
interface ConstInfoVar   { kind: 'non-const'; }

type ConstInfo = ConstInfoConst | ConstInfoDep | ConstInfoVar;
```
Rules (scalar nodes):
1. `LiteralNode` → `const` with its value.
2. `ColumnReference(attrId)` → `dep` with `{attrId}`.
3. Any other scalar node
   - If *not* functional → `non-const`.
   - Else inspect children:
     • If all children `const`  → evaluate immediately (see §4) → `const`.
     • If all children ∈ {`const`,`dep`} → `dep` with union of child `deps`.
     • Otherwise → `non-const`.

Relational nodes are initially `non-const`; attributes produced will be analysed in the top-down pass.

The `Map<PlanNodeId, ConstInfo>` is stored on the pass context.

---
## 3. Propagating constant attributes (top-down)

We now walk the *relational* tree from root to leaves carrying a set
`knownConstAttrs: Set<AttributeId>`.

For a relational node `R` with output attributes `A₀…Aₙ`:
1. For each projection / column-producing expression `Eᵢ`:
   - Look up `ConstInfo` of `Eᵢ`.
   - If `kind === 'const'`           → mark `Aᵢ` constant.
   - If `kind === 'dep'` and `deps ⊆ knownConstAttrs` → we can now fold `Eᵢ` (evaluate & replace) and mark `Aᵢ` constant.
2. After processing, add all newly constant `Aᵢ` to `knownConstAttrs` and recurse to child relations, translating attribute IDs through projection / join mapping.

The pass converges in a single traversal because the set of constant attributes only grows and every node is visited once.

---
## 4. Evaluation via runtime

When we decide to fold a scalar expression `expr`:
```ts
const instr   = emitPlanNode(expr, new EmissionContext(db /* temp */));
const sched   = new Scheduler(instr);
const rtCtx: RuntimeContext = {
  db, stmt: null, params: {},
  context: new Map(), tableContexts: new Map(),
  enableMetrics: false
};
const out  = sched.run(rtCtx);
const val  = out instanceof Promise ? await out : out;
const lit  = new LiteralNode(expr.scope, {type: 'literal', value: val});
```
Notes
- There is **no special row context**.  Column references resolve because they're replaced only when their source attribute is already folded to a literal, thus no `ColumnReferenceNode` survives evaluation.
- The scheduler may or may not be async; both paths are handled.
- Any exception aborts folding and leaves the original node untouched.

---
## 5. Folding relational constants

`ValuesNode` folding works automatically once every cell is `const`.  In the future, entire sub-queries can be folded if their relational node receives `ConstInfoConst` (e.g. `SELECT 1`).

---
## 6. API & integration points

### 6.1 Pass entry points
* **Builder level**: small helper `foldScalars(expr)` for builders like `VALUES`, default expressions, etc.
* **Optimizer rule** (existing `rule-constant-folding.ts`):
  1. Run bottom-up classification if cache is missing.
  2. Run top-down propagation from current relational node.
  3. Replace foldable scalar children.

### 6.2 Functional flag defaults
- `PlanNode.setDefaultPhysical()` sets `functional = deterministic && readonly` if omitted.
- Emitters for side-effecting scalar functions mark emitted nodes' physical.functional = false.

---
## 7. Correctness & safety

| Hazard                         | Mitigation                                                       |
|--------------------------------|------------------------------------------------------------------|
| Side-effects (`random()`, `now()`, UDF with mutations) | Those nodes have `functional=false`; never folded. |
| Future async UDFs              | Scheduler returns Promise; folding awaits it.                    |
| Column references before producer folded | Two-phase (bottom-up + top-down) ensures dependency sets resolved first. |

---
## 8. Extension ideas
* **Cost-based cut-off**: skip folding very large expression trees if projected gain is low.
* **Relational constant detection**: fold sub-queries that are provably constant (e.g., `SELECT COUNT(*) FROM (VALUES(1,2,3))`).

---
## 9. Implementation TODO list
1. Add `functional` flag to `PhysicalProperties`; helper `isFunctional(node)`.  Default logic in `PlanNode.setDefaultPhysical`.
2. Implement ConstInfo DFS in `analysis/const-pass.ts`.
3. Implement top-down propagation & folding helper `applyConstPropagation(root)`.  This mutates the tree by replacing scalar nodes with `LiteralNode`s and annotating constant attributes.
4. Replace interpreter in `analysis/constant-folding.ts` with runtime-based evaluator using the algorithm above.
5. Update unit tests & golden plans.
6. Document PRAGMA `quereus_constant_folding` once implemented.

---
### TL;DR
* **functional** flag indicates fold-safety.  
* Bottom-up builds dependency sets, top-down resolves them.  
* Evaluation uses the **existing runtime** through a mini-Scheduler.  
* No environment-variable logic is needed in the folding path. 
