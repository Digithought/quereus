---
description: Introduce a generic `EmptyRelationNode` (schema-polymorphic empty source) and a small const-fold pass that recognizes `Filter(x, lit-false)` / `Project(EmptyRelation, …)` and short-circuits the underlying subtree to nothing. This is a follow-up from the IND-existence-folding work, where the anti-join-to-empty rule emits `Filter(L, false)` rather than a true empty relation because no schema-polymorphic primitive exists.
files:
  - packages/quereus/src/planner/nodes/                   # new EmptyRelationNode source file
  - packages/quereus/src/runtime/emit/                    # corresponding emitter
  - packages/quereus/src/planner/rules/subquery/rule-anti-join-fk-empty.ts  # switch to EmptyRelationNode
  - packages/quereus/src/planner/rules/                   # new const-fold pass over Filter(lit-false) / Project(empty)
  - packages/quereus/test/optimizer/empty-relation.spec.ts
  - docs/optimizer.md
---

## Motivation

`rule-anti-join-fk-empty` (Structural priority 26) folds `AntiJoin(L, R, p)` to
`Filter(L, LiteralNode(false))` when the FK→PK inclusion guarantees the
anti-join is empty. This is correct, but the runtime `FilterNode` still
iterates every row of `L` to evaluate the constant-false predicate per row —
wasted work for local sources. The federated win (parent table `R` never
accessed) is achieved either way; only the local L iteration is wasted.

Two parts:

1. **`EmptyRelationNode`** — a relational primitive that produces zero rows of
   a caller-supplied attribute schema. Schema-polymorphic so anti-join-empty
   can hand it `L.getAttributes()` directly and downstream consumers see the
   same attribute IDs.
2. **Const-fold pass** — recognize `Filter(x, lit-false)`, `Project(EmptyRelation, …)`,
   and similar shapes, replacing them with `EmptyRelationNode` carrying the
   outer attribute schema. Should run in the Structural pass at a priority
   below the IND rules so it cleans up after them.

## Scope

- The pass must preserve attribute IDs at the boundary (callers above the
  empty subtree continue to find the same attribute IDs).
- Should also fold `Filter(EmptyRelation, …)`, `Project(EmptyRelation, …)`,
  `Sort(EmptyRelation, …)`, `Join(EmptyRelation, …, inner|cross)` → empty,
  `LeftJoin(EmptyRelation, R, …)` → R-side null-padded empty, etc. — work the
  details out in `plan/`.
- Out of scope: a SQL-level `VALUES (…) WHERE FALSE` parser shortcut.

## Notes from the IND-existence review

The anti-join-empty rule currently emits `Filter(L, LiteralNode(false))`. This
shape is documented as a placeholder; once `EmptyRelationNode` exists, switch
the rule to emit it directly (preserving L's attribute IDs).
