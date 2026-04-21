# Plan Tests

This directory contains two kinds of optimizer regression tests: **golden-plan tests** (snapshot-based) and **plan-shape tests** (assertion-based).

Run all plan tests:
```bash
yarn test:plans
```

## Golden Plan Tests

Capture exact plan structures as JSON snapshots for regression testing.

Each test consists of three files:
- `{test-name}.sql` - The SQL query to test
- `{test-name}.logical.json` - Expected logical plan structure
- `{test-name}.physical.json` - Expected physical plan structure after optimization

Update golden files when plans intentionally change:
```bash
UPDATE_PLANS=true yarn test:plans
```

Tests are organized in subdirectories by query pattern (`basic/`, `joins/`, `aggregates/`, etc.).

## Plan-Shape Tests

Assert that the optimizer picks expected physical operators (join type, aggregate strategy, index access, etc.) without pinning the full plan tree. Each `*.spec.ts` file covers one optimizer category:

- **predicate-pushdown** — FILTER placement relative to JOINs and projections; PK pushdown through views
- **join-selection** — HashJoin for equi-joins on non-ordered keys; MergeJoin/HashJoin for PK-to-PK; generic JOIN for cross joins
- **aggregate-strategy** — StreamAggregate for pre-sorted/scalar; HashAggregate for unsorted GROUP BY
- **subquery-decorrelation** — EXISTS/IN/NOT EXISTS decorrelation into joins
- **cte-materialization** — Single-ref inlining; multi-ref CTE references; RECURSIVECTE node
- **constant-folding** — Literal arithmetic/predicate/VALUES folding; deterministic function folding
- **index-selection** — IndexSeek/IndexScan for equality/range on indexed columns; SeqScan fallback

Shared test helpers live in `_helpers.ts`.
