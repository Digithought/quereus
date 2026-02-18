---
description: Type-specialized implementations for operators and functions
dependencies: Logical type system, planner type information

---

## Architecture

*Details to be filled out during planning phase.*

Use plan-time type information to select specialized implementations:
- Arithmetic: direct integer/float operations without type checks
- Comparison: type-specific from logicalType.compare
- String functions: skip validation when types known
- Aggregates: type-specific accumulation logic

Target: 1.5-2x speedup for expression evaluation.

Files: binary.ts, aggregate.ts, string builtins

**Principles:** SPP, DRY, modular architecture. Compile-time specialization.

## TODO

### Phase 1: Planning
- [ ] Audit current runtime type checks
- [ ] Design specialization strategy

### Phase 2: Implementation
- [ ] Implement arithmetic specialization
- [ ] Implement comparison specialization
- [ ] Update string functions
- [ ] Update aggregate functions

### Phase 3: Review & Test
- [ ] Review correctness
- [ ] Benchmark improvements

