description: Runtime feedback-driven re-optimization of query plans
dependencies: optimizer framework, statistics infrastructure, runtime execution

Adaptive query optimization uses runtime execution feedback to improve future query plans. When actual cardinalities or selectivities differ significantly from estimates, the system can adjust statistics or re-plan.

### Scope

- Runtime cardinality monitoring: track actual vs estimated row counts at key plan nodes during execution
- Statistics feedback: update table/column statistics based on observed runtime values
- Plan invalidation: detect when cached plans are likely suboptimal due to data changes
- Mid-execution re-optimization (longer term): pause execution and re-plan when a cardinality misestimate is detected early

### References

- `src/planner/cost/index.ts` - cost model and statistics
- `docs/optimizer.md` Future Directions section
