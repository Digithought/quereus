---
description: Plan comprehensive review of runtime subsystem (emitters, scheduler, execution)
dependencies: none
priority: 3
---

# Runtime Subsystem Review Planning

Plan a thorough adversarial review of the runtime execution engine.

## Scope

Files in `packages/quereus/src/runtime/`:
- `emit/` - Instruction emitters for each PlanNode type (~40 emitters)
- `emitters.ts` - Emitter dispatch and registration
- `register.ts` - Emitter registration
- `scheduler.ts` - Instruction execution engine
- `emission-context.ts` - Emission state management
- `context-helpers.ts` - Row context management utilities
- `deferred-constraint-queue.ts` - Constraint deferral
- `types.ts` - Runtime type definitions
- `utils.ts` - Runtime utilities
- `cache/` - Shared cache infrastructure

Documentation:
- `docs/runtime.md`

## Review Objectives

The planned review tasks should:

1. **Architecture Review**
   - Instruction graph construction patterns
   - Scheduler execution model correctness
   - Context helper usage consistency
   - Row descriptor management

2. **Code Quality Review**
   - Emitter pattern consistency across all emit/*.ts files
   - Context lifecycle management (push/pop balance)
   - Error handling and propagation
   - Async generator patterns and cleanup

3. **Test Coverage Assessment**
   - Emitter-by-emitter execution tests
   - Context leak detection tests
   - Scheduler edge cases (empty plans, errors)
   - Deferred constraint verification

4. **Defect Analysis**
   - Memory leaks in async iterators
   - Context corruption scenarios
   - Scheduler deadlock potential
   - Attribute resolution failures

## Output

This planning task produces detailed review tasks covering:
- Each emitter's correctness and test coverage
- Context helper robustness verification
- Scheduler stress testing
- Documentation accuracy validation
