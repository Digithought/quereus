description: Systematic review of utility modules (async, hashing, serialization, coercion)
dependencies: none
files:
  packages/quereus/src/util/affinity.ts
  packages/quereus/src/util/async-iterator.ts
  packages/quereus/src/util/cached.ts
  packages/quereus/src/util/coercion.ts
  packages/quereus/src/util/comparison.ts
  packages/quereus/src/util/environment.ts
  packages/quereus/src/util/event-support.ts
  packages/quereus/src/util/hash.ts
  packages/quereus/src/util/key-serializer.ts
  packages/quereus/src/util/latches.ts
  packages/quereus/src/util/mutation-statement.ts
  packages/quereus/src/util/patterns.ts
  packages/quereus/src/util/plan-formatter.ts
  packages/quereus/src/util/plugin-helper.ts
  packages/quereus/src/util/row-descriptor.ts
  packages/quereus/src/util/serialization.ts
  packages/quereus/src/util/sql-literal.ts
  packages/quereus/src/util/working-table-iterable.ts
----
Review utility modules: async iterator helpers, type coercion, value comparison, hashing, serialization, latches, and cross-platform environment detection.

Key areas of concern:
- Async iterator cleanup (finally blocks, break handling)
- Coercion correctness across type pairs
- Comparison function correctness (null ordering, collation, type mixing)
- Hash function distribution and collision properties
- Key serializer correctness for compound keys
- Latch/mutex correctness under concurrent access
- Cross-platform environment detection reliability

Follow the review protocol in docs/review.md.
Trivial fixes may be applied directly; non-trivial findings become fix/ or plan/ tickets.
