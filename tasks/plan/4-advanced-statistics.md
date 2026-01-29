---
description: VTab-supplied or ANALYZE-based statistics for cost estimation
dependencies: VTab API, optimizer cost model
priority: 4
---

## Architecture

*Details to be filled out during planning phase.*

Statistics infrastructure enabling accurate cardinality estimation. VTabs may supply statistics, or ANALYZE command collects them. Used by optimizer for join ordering and access path selection.

**Principles:** SPP, DRY, modular architecture. Statistics API should be module-agnostic.

## TODO

### Phase 1: Planning
- [ ] Design statistics API and storage
- [ ] Define ANALYZE command semantics

### Phase 2: Implementation
- [ ] Implement statistics collection and storage

### Phase 3: Review & Test
- [ ] Review API design
- [ ] Test statistics accuracy

