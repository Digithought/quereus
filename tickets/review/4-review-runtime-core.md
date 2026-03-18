description: Systematic review of runtime core (scheduler, emission context, FK actions, cache)
dependencies: none
files:
  packages/quereus/src/runtime/async-util.ts
  packages/quereus/src/runtime/context-helpers.ts
  packages/quereus/src/runtime/deferred-constraint-queue.ts
  packages/quereus/src/runtime/descriptor-helpers.ts
  packages/quereus/src/runtime/emission-context.ts
  packages/quereus/src/runtime/emitters.ts
  packages/quereus/src/runtime/foreign-key-actions.ts
  packages/quereus/src/runtime/register.ts
  packages/quereus/src/runtime/scheduler.ts
  packages/quereus/src/runtime/types.ts
  packages/quereus/src/runtime/utils.ts
  packages/quereus/src/runtime/cache/shared-cache.ts
----
Review runtime core infrastructure: async utilities, emission context (runtime state management), emitter registry, scheduler, foreign key action execution, deferred constraint queue, descriptor helpers, shared cache, and runtime type definitions.

Key areas of concern:
- Emission context — lifecycle, nesting, cleanup
- Scheduler — async task ordering, error propagation
- Foreign key actions — cascade depth limit, cycle detection
- Deferred constraint queue — flush timing, ordering guarantees
- Shared cache — eviction policy, memory bounds, concurrent access
- Emitter registry — completeness (all node types have emitters)
- Async utilities — cancellation, timeout handling
- Register management — allocation and reuse

Follow the review protocol in docs/review.md.
Trivial fixes may be applied directly; non-trivial findings become fix/ or plan/ tickets.
