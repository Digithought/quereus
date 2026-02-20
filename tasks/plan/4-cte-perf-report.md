---
description: Investigate and address a specific CTE performance issue
---

```sql
with recursive
  entity_tree(id) as (
    select id from Entity where id = ?
    union all
    select E.id from Entity E join entity_tree T on E.component_id = T.id
  ),
  ancestor_walk(entity_id, ancestor_id, depth) as (
    select E.id, E.component_id, 0
    from Entity E
    where E.id in (select id from entity_tree) and E.component_id is not null
    union all
    select W.entity_id, P.component_id, W.depth + 1
    from ancestor_walk W
    join Entity P on W.ancestor_id = P.id
    where P.component_id is not null
  )
select W.entity_id, W.ancestor_id, W.depth as ancestor_depth, ...
from ancestor_walk W join Entity A on W.ancestor_id = A.id
order by W.entity_id, W.depth desc
```

**Issue**: Two nested recursive CTEs — first walks descendants, then walks ancestors for each. On 60 entities this produces O(n * depth) rows. Quereus may not optimize the `IN (select ...)` subquery inside the second CTE.

**Upstream ask**: Optimize recursive CTE performance, especially nested CTEs with subquery predicates. Consider materializing intermediate CTE results.

Also: Verify that recursive CTE with bind-parameter termination condition (`P.id != ?`) optimized well.  And if these fixes are already represented in another task, remove or update it.
