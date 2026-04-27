---
description: Reusable incremental delta runtime for assertions and materialized views
prereq: Assertion infrastructure, optimizer, savepoint system

---

## Architecture

*Details to be filled out during planning phase.*

Shared delta pipeline kernel:
- ParameterizedPlanCache keyed by (registrant, relationKey, key-shape)
- DeltaExecutor for global vs per-binding runs with early-exit
- Savepoint-aware ChangeCapture

Optimizer binding-aware analysis for group-specific keys and binding propagation.

Future: Materialized views with incremental ΔView computation.

**Principles:** SPP, DRY, modular architecture. Single reusable kernel for multiple consumers.
