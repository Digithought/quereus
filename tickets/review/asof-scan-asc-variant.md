---
description: Recognize ASC variant of lateral-top-1 asof (`q.K >= left.K order by q.K asc limit 1`)
files:
  - packages/quereus/src/planner/rules/join/rule-lateral-top1-asof.ts
  - packages/quereus/src/planner/nodes/asof-scan-node.ts
  - packages/quereus/src/runtime/emit/asof-scan.ts
  - packages/quereus/test/optimizer/asof-scan.spec.ts
  - packages/quereus/test/logic/84-asof-scan.sqllogic
  - docs/optimizer.md
---

`ruleLateralTop1Asof` now recognizes both directions of the lateral-top-1
asof pattern:

- **'desc'** (existing): `q.K <= t.K order by q.K desc limit 1` →
  *latest right ≤ left.K*
- **'asc'** (new): `q.K >= t.K order by q.K asc limit 1` →
  *earliest right ≥ left.K*

Each direction also accepts the strict variant (`<` / `>`) and all four
mirrored operator forms (`q.K op t.K` and `t.K op' q.K`). Sort direction
must agree with the predicate; mismatched pairs (e.g. `q.K <= t.K` with
`order by q.K asc`) leave the rule inert.

## Implementation summary

- **`AsofScanNode`** — new public field `direction: 'asc' | 'desc'` threaded
  through the constructor, `withChildren`, `toString`, and
  `getLogicalAttributes` (so `query_plan(...).properties.direction` is
  observable). The right input must still advertise
  `monotonicOn(matchAttr, asc)` and `accessCapabilities.asofRight`; only the
  cursor-walk semantics flip per direction.
- **Rule** — `extractSortAttrId` now returns `{ attrId, direction }` for both
  asc and desc keys. `classifyPredicates` canonicalizes the asof inequality
  to `(rightCol op leftCol)` and maps each operator (`<=`, `<`, `>=`, `>`,
  plus the four mirrors) to a `(strict, direction)` pair. The rule rejects
  any (sort.direction, asof.direction) mismatch.
- **Emitter** — branches the per-bucket cursor advancement on `direction`:
  - `'desc'`: cursor starts at `-1` (before bucket); advance while
    `bucket[cursor+1].match` still qualifies (`≤` left.match, or `<` strict).
    Cursor sits on the last qualifying row.
  - `'asc'`: cursor starts at `0`; advance while `bucket[cursor].match` is
    still too small (`<` left.match, or `≤` strict). Cursor sits on the
    first qualifying row, or past-the-end when none qualifies.
  Both modes maintain the `O(L + R)` streaming cost; the right input is
  bucketed once in ascending match order.

## Use cases / validation

- New optimizer-spec cases in `asof-scan.spec.ts`:
  - asc + non-strict + partition recognized (`direction === 'asc'`)
  - asc + strict (`q.ts > t.ts`) recognized
  - mismatched pairs (`q.ts <= t.ts` + `asc`, and `q.ts >= t.ts` + `desc`)
    do **not** produce an `ASOFSCAN`
  - desc cases now also assert `direction === 'desc'` in `properties`
- New logic cases in `84-asof-scan.sqllogic`:
  - plan-shape probe for asc form
  - partitioned non-strict asc (cross-partition interleaved cursor walk)
  - boundary-tie test contrasting non-strict asc vs strict asc
  - inner cross-join lateral asc drops unmatched left rows
  - unpartitioned asc

## Build & test status

- `yarn workspace @quereus/quereus run build` — clean
- `yarn workspace @quereus/quereus run lint` — clean
- `yarn workspace @quereus/quereus run test` — 2647 passing, 2 pending (no
  new failures vs. baseline)

## Review checklist

- Inspect cursor-walk correctness in `emitAsofScan` for the asc branch,
  especially the strict/non-strict comparator polarity (`cmp <= 0` vs
  `cmp < 0`) and the past-the-end bookkeeping (`cursor < bucket.length`).
- Confirm `classifyPredicates` returns null for any mixed inequality that
  doesn't fit a single direction (e.g., one `<=` plus one `>=` on the same
  right key — the second occurrence is rejected by the existing
  "multiple asof inequalities — bail" guard).
- Spot-check `docs/optimizer.md § Streaming asof scan` for accuracy of the
  new asc form and the new sort/predicate-direction bail condition.
