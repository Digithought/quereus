description: Benchmark harness with trackable results for performance regression detection
dependencies: none (no new packages — use built-in performance.now())
files:
  - packages/quereus/bench/run.mjs (new — benchmark runner)
  - packages/quereus/bench/suites/ (new — benchmark suite files)
  - packages/quereus/bench/results/ (new — .gitignored JSON output)
  - packages/quereus/package.json (add bench script)
  - packages/quereus/.gitignore (ignore bench/results/)
  - packages/quereus/test/performance-sentinels.spec.ts (reference for existing patterns)
----

## Overview

The existing `performance-sentinels.spec.ts` guards against catastrophic regressions with generous thresholds. A proper benchmark suite measures throughput precisely, records results to JSON, and enables trend comparison across commits.

This is not a Mocha test — it's a standalone script invoked via `yarn bench`. Results are written to `bench/results/<timestamp>.json` for manual or scripted comparison.

## Design

### Runner (`bench/run.mjs`)

A simple Node.js script that:
1. Dynamically imports each suite from `bench/suites/`
2. For each benchmark: runs warmup iterations, then timed iterations
3. Records median, p95, min, max for each benchmark
4. Writes results JSON to `bench/results/`
5. Optionally compares against a baseline file (pass `--baseline <path>`)

Configuration per benchmark:
- `warmup`: number of warmup iterations (default 3)
- `iterations`: number of measured iterations (default 10)
- `setup`: async function run once before all iterations
- `teardown`: async function run once after all iterations
- `fn`: the function being benchmarked (async)

### Benchmark Suites

**`parser.bench.ts`** — Parser throughput
- Simple SELECT parse (single table, 3 columns, WHERE)
- Complex SELECT parse (joins, subqueries, CTEs)
- Wide SELECT parse (50 columns)
- INSERT with VALUES parse

**`planner.bench.ts`** — Planner throughput (parse + plan, subtract parse time)
- Simple scan plan
- Join plan (2 tables)
- Aggregate plan with GROUP BY
- Subquery plan

**`execution.bench.ts`** — End-to-end query execution
- Full table scan (10K rows)
- Filtered scan with index (10K rows, ~100 matches)
- GROUP BY aggregate (10K rows, 100 groups)
- ORDER BY (10K rows)
- Hash/bloom join (1K x 1K)
- Correlated subquery (100 outer x 1K inner)

**`mutation.bench.ts`** — Write operations
- Bulk insert (10K rows via multi-row VALUES)
- Single-row insert (1K prepared statement executions)
- UPDATE with WHERE (1K rows affected out of 10K)
- DELETE with WHERE (100 rows out of 10K)

### Output Format

```json
{
  "timestamp": "2026-03-05T...",
  "commit": "abc1234",
  "node": "v22.x.x",
  "benchmarks": {
    "parser/simple-select": { "median_ms": 0.12, "p95_ms": 0.18, "min_ms": 0.10, "max_ms": 0.25, "iterations": 10 },
    ...
  }
}
```

### Comparison Mode

When `--baseline <file>` is provided, print a table showing each benchmark's delta vs baseline. Flag regressions >20% in red.

### Key Expected Behaviors
- `yarn bench` runs all suites, prints a summary table, writes JSON
- `yarn bench --baseline bench/results/prev.json` shows deltas
- Each suite runs independently (fresh Database per suite)
- Total bench time under 2 minutes

## TODO

- Create `bench/` directory structure
- Implement benchmark runner (`bench/run.mjs`) with warmup, timing, statistics, JSON output
- Implement parser benchmark suite
- Implement planner benchmark suite
- Implement execution benchmark suite
- Implement mutation benchmark suite
- Add comparison mode (--baseline)
- Add `"bench"` script to `packages/quereus/package.json`
- Add `bench/results/` to `.gitignore`
- Run benchmarks and verify output format
