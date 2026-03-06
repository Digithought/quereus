description: Additional physical aggregation operators beyond stream aggregate
dependencies: aggregate rule, physical properties, cost model

Currently the optimizer has `StreamAggregateNode` as the sole physical aggregation operator. For unsorted inputs, a sort is injected before stream aggregation. A hash-based aggregation operator would avoid sorting costs when the input is large and unsorted.  We now have hashing primitives via bloom, so this may now be within reach; we didn't have that when this ticket was written.

### Scope

- Hash aggregate operator: build a hash map keyed by GROUP BY columns, accumulate aggregate state per group, emit all groups at end
- Cost model comparison: hash aggregate vs sort+stream aggregate, considering input size and available memory
- Optimizer rule to select between hash aggregate and stream aggregate based on cost
- Partial/parallel aggregation (longer term): compute partial aggregates in parallel, merge results

### References

- `src/planner/rules/aggregate/` - current aggregate optimization
- `src/planner/cost/index.ts` - cost model
- `docs/optimizer.md` Future Directions section
