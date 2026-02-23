---
description: Key-driven row-count reduction with FK→PK inference and optimizer exploitation
dependencies: None (builds on existing key propagation infrastructure)
---

## Context

The optimizer already tracks unique keys at two levels:
- **Logical keys** (`RelationType.keys`) from schema PK definitions
- **Physical keys** (`PhysicalProperties.uniqueKeys`) derived per plan node

Key propagation works through most nodes (Filter, Project, Distinct, Aggregate, Sort, Limit, Join). The `JoinNode.computePhysical()` already detects when equi-join pairs cover a unique key on one side and preserves the other side's keys + sets `estimatedRows` accordingly.

However, several gaps remain that prevent the optimizer from fully exploiting key information for cardinality estimation.

## Architecture

### Gap 1: Physical Join Nodes Miss Key-Driven `estimatedRows`

`BloomJoinNode.computePhysical()` and `MergeJoinNode.computePhysical()` both detect key coverage and preserve `uniqueKeys`, but **do not** set `estimatedRows` when key coverage is found. The logical `JoinNode.computePhysical()` does this correctly (lines 127-130 of `join-node.ts`), but the physical nodes don't.

Additionally, the key-coverage analysis logic is duplicated across all three join nodes (`JoinNode`, `BloomJoinNode`, `MergeJoinNode`). This violates DRY.

**Fix**: Extract key-coverage analysis into a shared utility in `key-utils.ts`, and apply it consistently in all join nodes for both `uniqueKeys` and `estimatedRows`.

### Gap 2: FK/Unique Constraint Schema Storage

FK constraints are fully parsed in the AST (`ForeignKeyClause` in `parser/ast.ts`) but not stored in `TableSchema` (commented out at line 61 of `schema/table.ts`). Secondary UNIQUE constraints are similarly commented out (line 63).

Without FK metadata in the schema, the optimizer cannot infer FK→PK relationships during join analysis.

**Fix**: Define `ForeignKeyConstraintSchema` and `UniqueConstraintSchema` types, uncomment and populate them on `TableSchema`, wire up extraction from AST constraints during CREATE TABLE, and expose UNIQUE constraints as additional keys in `RelationType`.

### Gap 3: FK→PK Join Key Inference

When the optimizer sees `orders.customer_id = customers.id` and knows `orders.customer_id` is a FK referencing `customers.id` (PK), each `orders` row matches **at most one** `customers` row. The existing equi-join key-coverage logic already handles the PK side correctly (it detects that `customers.id` is covered), but cannot go the other direction: inferring that FK-side columns constrain the join cardinality via the FK relationship.

Specifically, FK→PK inference enables:
- `estimatedRows ≤ FK-side rows` (not `FK * PK * 0.1`)
- FK-side unique keys are preserved through the join
- Better selectivity estimates in `StatsProvider`

**Fix**: Enhance `rule-join-key-inference.ts` to look up FK constraints on join sides. When a FK relationship aligns with equi-join predicates, annotate the join with FK metadata and propagate the key implications.

### Gap 4: Optimizer Exploitation

Better cardinality estimates feed into:
- **Join strategy selection** (`rule-join-physical-selection.ts`): Already uses `estimatedRows` for cost comparison — fixing the estimates automatically improves strategy choices.
- **QuickPick join enumeration** (`rule-quickpick-enumeration.ts`): Uses `getTotalCost()` which incorporates `estimatedRows` — fixing estimates improves join ordering.
- **DISTINCT elimination**: When output `uniqueKeys` guarantee the output is already unique, a downstream DISTINCT is redundant. Add a rule to detect and eliminate this.

## Key Files

| File | Role |
|------|------|
| `src/schema/table.ts` | `TableSchema` — add FK/unique constraint storage |
| `src/schema/column.ts` | `ColumnSchema` — no change needed |
| `src/common/datatype.ts` | `RelationType` — keys already defined |
| `src/planner/util/key-utils.ts` | Shared key utilities — add join key-coverage analysis |
| `src/planner/nodes/join-node.ts` | Logical join — refactor to use shared utility |
| `src/planner/nodes/bloom-join-node.ts` | Hash join — add key-driven `estimatedRows` |
| `src/planner/nodes/merge-join-node.ts` | Merge join — add key-driven `estimatedRows` |
| `src/planner/rules/join/rule-join-key-inference.ts` | FK→PK inference rule |
| `src/planner/stats/catalog-stats.ts` | Stats — FK-aware join selectivity |
| `src/planner/building/build-create-table.ts` | CREATE TABLE — extract FK/unique constraints |
| `test/optimizer/keys-propagation.spec.ts` | Existing key tests — extend |
| `docs/optimizer.md` | Update key-driven section |

## Implementation

### Phase 1: DRY Join Key-Coverage Utility

Extract the shared key-coverage logic from the three join nodes into `key-utils.ts`.

Add to `key-utils.ts`:
```typescript
export interface JoinKeyCoverageResult {
  leftKeyCovered: boolean;
  rightKeyCovered: boolean;
  uniqueKeys: number[][] | undefined;
  estimatedRows: number | undefined;
}

export function analyzeJoinKeyCoverage(
  joinType: JoinType,
  leftPhys: PhysicalProperties,
  rightPhys: PhysicalProperties,
  leftType: RelationType,
  rightType: RelationType,
  equiPairs: Array<{ left: number; right: number }>,
  leftRows: number | undefined,
  rightRows: number | undefined,
): JoinKeyCoverageResult
```

Refactor `JoinNode.computePhysical()`, `BloomJoinNode.computePhysical()`, and `MergeJoinNode.computePhysical()` to call this shared function.

**Critically**: The physical join nodes (`BloomJoinNode`, `MergeJoinNode`) must now set `estimatedRows` in their `computePhysical()` return value when key coverage is detected. Currently they only set `uniqueKeys`.

### Phase 2: FK & Unique Constraint Schema

In `schema/table.ts`, define:
```typescript
export interface ForeignKeyConstraintSchema {
  name?: string;
  columns: ReadonlyArray<string>;       // FK columns on this table
  referencedTable: string;              // Referenced table name
  referencedSchema?: string;            // Referenced schema (default: same)
  referencedColumns: ReadonlyArray<string>; // Referenced columns (default: PK)
  onDelete?: ForeignKeyAction;
  onUpdate?: ForeignKeyAction;
}

export interface UniqueConstraintSchema {
  name?: string;
  columns: ReadonlyArray<{ name: string; desc?: boolean }>;
}
```

Uncomment and populate `foreignKeys` and `uniqueConstraints` on `TableSchema`.

In the CREATE TABLE builder (wherever `tableConstraints` and column constraints are processed):
- Extract `type: 'foreignKey'` table constraints → `foreignKeys`
- Extract `foreignKey` from column constraints → `foreignKeys`
- Extract `type: 'unique'` table constraints → `uniqueConstraints`
- Extract `type: 'unique'` column constraints → `uniqueConstraints`

In `type-utils.ts` (or wherever `RelationType` is built from `TableSchema`):
- Include unique constraint columns as additional entries in `RelationType.keys`

### Phase 3: FK→PK Join Inference

Enhance `rule-join-key-inference.ts`:

1. When a `JoinNode` has equi-join pairs, look up the source `TableSchema` for each side (via the `RetrieveNode` → `TableReferenceNode` chain or scope).
2. Check if any equi-pair column on one side has a FK constraint referencing the other side's table.
3. If FK columns on side A reference PK columns on side B, and the equi-join pairs align with this FK→PK relationship, then:
   - Side B's key is covered (each FK row matches ≤1 PK row)
   - This is equivalent to `coversLogicalKey('right')` returning true
4. The rule can either annotate the join node or directly rebuild it so that `computePhysical` sees the FK→PK coverage. The simplest approach: add a `fkCoverage` property to `JoinNode` that the key-coverage utility checks in addition to equi-pair analysis.

Alternatively (simpler): The existing `coversLogicalKey` check already works when the PK side's key is covered by equi-pairs. What's NOT captured today is when the FK→PK relationship allows us to infer things about the FK side. Specifically:
- FK containment: every FK value exists in the PK column → no null-extension rows for inner join
- FK selectivity: `joinSelectivity = 1 / max(ndv_pk, 1)` when FK references PK

The main win is in `StatsProvider.joinSelectivity()`: when we detect FK→PK, use `1 / ndv_pk` instead of heuristics. This requires schema access in the stats provider.

### Phase 4: DISTINCT Elimination Rule

Add a new optimizer rule `rule-distinct-elimination.ts`:
- Pattern: `DistinctNode` whose source already has `uniqueKeys` that cover all output columns
- Action: Remove the `DistinctNode`, replacing it with its source
- Phase: Structural pass, priority ~18 (after key inference, before predicate pushdown)

This is a natural exploitation of better key propagation.

### Phase 5: Tests & Documentation

Extend `test/optimizer/keys-propagation.spec.ts`:
- Test that physical join nodes (`BloomJoinNode`, `MergeJoinNode`) have key-driven `estimatedRows`
- Test FK→PK join produces correct cardinality estimate
- Test DISTINCT elimination when keys guarantee uniqueness
- Test unique constraint keys propagate through joins

Add sqllogic test file `test/logic/84-key-cardinality.sqllogic`:
- FK→PK join cardinality verification via `query_plan()`
- DISTINCT elimination verification
- Multi-table join ordering influenced by key-driven estimates

Update `docs/optimizer.md`:
- Fill in the "Key-driven row-count reduction" TODO section
- Document FK→PK inference
- Document DISTINCT elimination rule

## TODO

### Phase 1: DRY join key-coverage utility
- Add `analyzeJoinKeyCoverage()` to `src/planner/util/key-utils.ts`
- Refactor `JoinNode.computePhysical()` to use it
- Refactor `BloomJoinNode.computePhysical()` to use it — **add `estimatedRows`**
- Refactor `MergeJoinNode.computePhysical()` to use it — **add `estimatedRows`**

### Phase 2: FK & unique constraint schema
- Define `ForeignKeyConstraintSchema` and `UniqueConstraintSchema` in `schema/table.ts`
- Uncomment and populate `foreignKeys` and `uniqueConstraints` on `TableSchema`
- Extract FK/unique constraints from AST during CREATE TABLE
- Include unique constraint columns as additional keys in `RelationType`

### Phase 3: FK→PK join inference
- Enhance `rule-join-key-inference.ts` to detect FK→PK via schema lookup
- Enhance `StatsProvider.joinSelectivity()` with FK-aware selectivity
- Wire FK metadata through to join key-coverage analysis

### Phase 4: DISTINCT elimination rule
- Add `rule-distinct-elimination.ts`
- Register in optimizer structural pass

### Phase 5: Tests & docs
- Extend `keys-propagation.spec.ts` with physical join and FK tests
- Add `84-key-cardinality.sqllogic`
- Update `docs/optimizer.md` key-driven section
- Ensure build and all tests pass
