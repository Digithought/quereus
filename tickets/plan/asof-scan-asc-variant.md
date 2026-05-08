---
description: Recognize ASC variant of lateral-top-1 asof (`q.K >= left.K order by q.K asc limit 1`)
files:
  - packages/quereus/src/planner/rules/join/rule-lateral-top1-asof.ts
  - packages/quereus/src/planner/nodes/asof-scan-node.ts
  - packages/quereus/src/runtime/emit/asof-scan.ts
---

The current `ruleLateralTop1Asof` only recognizes the descending lateral-top-1
shape — `where q.K <= left.K order by q.K desc limit 1` — which corresponds to
"latest right ≤ left.K." The symmetric ascending shape — "earliest right ≥
left.K" — is also valid asof semantics:

```sql
select t.*, q.bid
from (select * from trades order by ts) t
left join lateral (
  select bid from quotes q where q.symbol = t.symbol and q.ts >= t.ts
  order by q.ts asc limit 1
) q on true;
```

The rule's `extractSortAttrId` currently bails when `direction !== 'desc'`, and
`classifyPredicates` only canonicalizes `q.K <= left.K` (and `<`).

To support the ASC form:
- Allow `direction === 'asc'` in `extractSortAttrId`.
- Add a `direction` field on `AsofScanNode` (or a `mode: 'latest-le' | 'earliest-ge'`).
- In the emitter, advance the right cursor while `candidate.match < left.match`
  (or `<=` strict-asc) instead of advancing to find the largest ≤. The cursor
  semantics flip: per partition, find the smallest right.match that is ≥
  left.match, then record (and only consider rows ≥ that match for subsequent
  larger left rows).

The right input must still advertise `monotonicOn(K, asc)`; the left must
still be monotonic on its match attr (asc).

Tests should mirror the DESC suite (test/optimizer/asof-scan.spec.ts and
test/logic/84-asof-scan.sqllogic).
