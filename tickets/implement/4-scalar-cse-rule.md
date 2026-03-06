description: Scalar common subexpression elimination optimizer rule
dependencies: 4-expression-fingerprinting
files:
  - packages/quereus/src/planner/analysis/expression-fingerprint.ts (from dependency ticket)
  - packages/quereus/src/planner/rules/cache/rule-scalar-cse.ts (new)
  - packages/quereus/src/planner/optimizer.ts (register new rule)
  - packages/quereus/src/planner/nodes/project-node.ts (ProjectNode, Projection)
  - packages/quereus/src/planner/nodes/filter.ts (FilterNode)
  - packages/quereus/src/planner/nodes/plan-node.ts (ScalarPlanNode, Attribute, isScalarNode)
  - packages/quereus/src/planner/nodes/reference.ts (ColumnReferenceNode)
  - packages/quereus/src/planner/framework/registry.ts (rule registration)
  - packages/quereus/src/planner/framework/pass.ts (PassId)
  - packages/quereus/src/planner/framework/characteristics.ts (PredicateCapable, ProjectionCapable)
  - packages/quereus/src/planner/nodes/sort.ts (SortNode, SortKey)
  - packages/quereus/src/planner/nodes/aggregate-node.ts (AggregateNode)
  - packages/quereus/test/optimizer/ (test location)
  - docs/optimizer.md
----

## Scalar CSE Rule

An optimizer rule that detects duplicate scalar expression computations across sibling relational nodes (e.g., Project + Filter + Sort) and ensures each unique expression is computed only once.

### Motivation

In queries like:
```sql
SELECT length(name), upper(name) FROM t WHERE length(name) > 5
SELECT *, price * qty AS total FROM orders WHERE price * qty > 100 ORDER BY price * qty
```

The expressions `length(name)` and `price * qty` are evaluated multiple times. CSE computes each once and reuses the result via column references.

### Approach: Project-injection CSE

The rule targets `ProjectNode` in the Structural pass. When a ProjectNode's sibling relational nodes (filter, sort below it) contain scalar expressions matching expressions in the projection list, the rule:

1. Collects all scalar expressions from the ProjectNode and its immediate relational child chain (FilterNode, SortNode) using `fingerprintExpression()`
2. Groups by fingerprint, keeping only groups with 2+ occurrences
3. For each duplicate group, picks the "canonical" instance (first encountered)
4. Creates a new ProjectNode below the lowest usage point that computes each deduplicated expression once and assigns it a new attribute
5. Replaces all duplicate occurrences with `ColumnReferenceNode` pointing to the new attribute

### Example transformation

Before:
```
ProjectNode [length(name), upper(name)]
  FilterNode [length(name) > 5]
    SeqScan t
```

After:
```
ProjectNode [col_ref($len), upper(name)]
  FilterNode [col_ref($len) > 5]
    ProjectNode [*, length(name) as $len]     <-- injected
      SeqScan t
```

The injected ProjectNode uses `preserveInputColumns: true` to pass through all source columns plus the new computed column.

### Rule registration

- **Pass**: Structural (PostOptimization is too late - physical nodes are already chosen)
- **Node type**: `PlanNodeType.Project`
- **Priority**: 22 (after predicate pushdown at 20, before subquery decorrelation at 25)
- **Rule ID**: `'scalar-cse'`

### Guards

- Only deduplicate **deterministic** expressions (`node.physical.deterministic !== false`)
- Only deduplicate expressions with cost > 0 (skip bare column references and literals - they're cheap to recompute)
- Minimum expression tree depth or cost threshold to avoid overhead for trivial expressions
- Don't apply if there are no duplicates (return `null`)
- Must preserve attribute IDs on the outer ProjectNode

### Design notes

- The rule walks the chain: Project → Filter → Sort → ... (the relational child chain)
- It collects `{fingerprint, node, location}` tuples where location identifies which parent node and position the expression lives in
- After identifying duplicates, it constructs the injected ProjectNode with passthrough + computed columns
- It then replaces duplicate expressions in the outer nodes with ColumnReferenceNodes
- The replacement uses `withChildren()` / `withProjections()` / `withPredicate()` to reconstruct immutably

### Scope limitations (v1)

- Only handles linear chains (Project → Filter → Sort → source). Does not cross join boundaries.
- Does not handle CSE across different branches of a UNION or JOIN.
- Does not handle relational CSE (identical subquery trees). That's future work.
- Does not canonicalize commutative operators (unless fingerprinting implements it).

### Testing

Tests in `packages/quereus/test/optimizer/scalar-cse.test.ts` or as sqllogic tests:

Key test cases:
- `SELECT length(name), x FROM t WHERE length(name) > 5` - length(name) computed once
- `SELECT price*qty AS total FROM orders WHERE price*qty > 100 ORDER BY price*qty` - price*qty computed once
- `SELECT random() FROM t WHERE random() > 0.5` - non-deterministic NOT deduplicated
- `SELECT name FROM t WHERE name > 'a'` - bare column refs NOT deduplicated (cheap)
- `SELECT length(name) FROM t WHERE length(name) > 5 AND length(name) < 20` - still just one computation
- `SELECT a+b, a+b FROM t` - intra-projection duplicates eliminated
- Verify correctness: results match non-CSE execution

### Documentation

Update `docs/optimizer.md`:
- Add scalar CSE to the Structural pass description
- Add a brief section on CSE in the rule catalog

## TODO

### Phase 1: Rule implementation
- Create `packages/quereus/src/planner/rules/cache/rule-scalar-cse.ts`
- Implement expression collection from Project + child chain
- Implement fingerprint grouping and duplicate detection
- Implement ProjectNode injection with passthrough columns
- Implement expression replacement with ColumnReferenceNodes

### Phase 2: Integration
- Register rule in `packages/quereus/src/planner/optimizer.ts` in the Structural pass
- Ensure build passes
- Ensure existing tests still pass

### Phase 3: Testing
- Write optimizer tests for scalar CSE
- Write sqllogic tests verifying correctness
- Update `docs/optimizer.md` with CSE documentation
