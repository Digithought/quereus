description: Systematic review of join plan nodes (nested-loop, bloom, merge)
dependencies: none
files:
  packages/quereus/src/planner/nodes/join-node.ts
  packages/quereus/src/planner/nodes/bloom-join-node.ts
  packages/quereus/src/planner/nodes/merge-join-node.ts
----
Review join plan nodes: nested-loop join, bloom filter join, and merge join.

Key areas of concern:
- Join type correctness (inner, left, right, full, cross, semi, anti)
- Null handling in join predicates
- Bloom join — false positive rate assumptions, hash function choice
- Merge join — sort order requirements, duplicate key handling
- Output column composition from left + right inputs
- Outer join null padding correctness
- Join condition vs filter condition separation

Follow the review protocol in docs/review.md.
Trivial fixes may be applied directly; non-trivial findings become fix/ or plan/ tickets.
