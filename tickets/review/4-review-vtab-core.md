description: Systematic review of virtual table core interfaces
dependencies: none
files:
  packages/quereus/src/vtab/best-access-plan.ts
  packages/quereus/src/vtab/capabilities.ts
  packages/quereus/src/vtab/connection.ts
  packages/quereus/src/vtab/events.ts
  packages/quereus/src/vtab/filter-info.ts
  packages/quereus/src/vtab/index-info.ts
  packages/quereus/src/vtab/manifest.ts
  packages/quereus/src/vtab/module.ts
  packages/quereus/src/vtab/table.ts
----
Review virtual table core: module interface, table abstraction, connection management, index/filter info, access plan selection, and capabilities.

Key areas of concern:
- VTab interface contract completeness and clarity
- Index info / filter info correctness for query planning
- Best access plan selection logic
- Connection lifecycle and cleanup
- Capability flags consistency
- Event emission for table mutations

Follow the review protocol in docs/review.md.
Trivial fixes may be applied directly; non-trivial findings become fix/ or plan/ tickets.
