description: Benchmark harness with trackable results for performance regression detection
dependencies: none
files:
  - packages/quereus/bench/run.mjs (benchmark runner)
  - packages/quereus/bench/suites/parser.bench.mjs (parser throughput)
  - packages/quereus/bench/suites/planner.bench.mjs (planner throughput)
  - packages/quereus/bench/suites/execution.bench.mjs (end-to-end queries)
  - packages/quereus/bench/suites/mutation.bench.mjs (write operations)
  - packages/quereus/bench/results/ (.gitignored JSON output)
  - packages/quereus/package.json (added "bench" script)
  - .gitignore (added bench/results/)
----

## What Was Built

A standalone benchmark suite for Quereus, run via `yarn bench`. It measures parser, planner, execution, and mutation throughput, records results to timestamped JSON files, and supports baseline comparison with `--baseline <file>`.

### Runner (`bench/run.mjs`)
- Dynamically discovers all `*.bench.mjs` files in `bench/suites/`
- Per benchmark: configurable warmup + timed iterations
- Computes median, p95, min, max per benchmark
- Writes results JSON with timestamp, commit hash, and Node version
- `--baseline <path>` prints a delta table with color-coded regressions (>20% red) and improvements (>10% green)
- Exits non-zero when regressions exceed 20%

### Benchmark Suites

**parser.bench.mjs** (4 benchmarks)
- simple-select, complex-select (joins/subqueries/CTEs), wide-select-50cols, insert-values

**planner.bench.mjs** (4 benchmarks)
- simple-scan-plan, join-plan, aggregate-plan, subquery-plan
- Measures prepare+finalize (parse + plan) time

**execution.bench.mjs** (6 benchmarks)
- full-scan-10k, filtered-scan-index-10k, group-by-10k, order-by-10k, join-1kx1k, correlated-subquery
- Uses 10K row tables with indexes

**mutation.bench.mjs** (4 benchmarks)
- bulk-insert-10k, single-row-insert-1k, update-where-1k, delete-where-100
- Insert/delete benchmarks use fresh Database per iteration for clean state

### Output Format
```json
{
  "timestamp": "2026-03-06T...",
  "commit": "f956ed4",
  "node": "v24.2.0",
  "benchmarks": {
    "parser/simple-select": { "median_ms": 0.012, "p95_ms": 0.015, ... },
    ...
  }
}
```

## Testing & Validation
- `yarn bench` runs all 18 benchmarks, prints summary table, writes JSON — verified working
- `yarn bench --baseline <file>` shows per-benchmark deltas with color coding — verified working
- Total bench time ~90 seconds on dev machine
- Build passes, existing tests unaffected (pre-existing 1 failure in semi-anti-join unrelated)
- `bench/results/` is .gitignored

## Usage
```sh
cd packages/quereus
yarn bench                                          # run all, write JSON
yarn bench --baseline bench/results/prev.json       # compare against baseline
```
