---
description: Master orchestration plan for all review tasks
dependencies: none
priority: 1
---

# Master Orchestration Plan for Code Reviews

This document serves as the master orchestration plan for all review tasks, providing guidance on execution order, dependencies, and coordination.

## 1. Review Task Overview

### Core Subsystem Reviews (Priority 1-2)

| Task | Task doc | Dependencies | Estimated Effort |
|------|------|--------------|------------------|
| Parser Review | `tasks/complete/3-review-core-parser.md` | None | High |
| Planner Review | `tasks/implement/3-review-core-planner.md` | Parser | High |
| Optimizer Review | `tasks/implement/3-review-core-optimizer.md` | Planner | High |
| Runtime Review | `tasks/implement/3-review-core-runtime.md` | Optimizer | High |
| Schema Review | `tasks/complete/3-review-core-schema.md` | None | Medium |
| Types Review | `tasks/complete/3-review-core-types.md` | None | Medium |
| Utilities Review | `tasks/implement/3-review-core-utilities.md` | Types | Low |
| API Review | `tasks/complete/3-review-core-api.md` | All core | Medium |
| VTab Review | `tasks/implement/3-review-core-vtab.md` | Schema, Runtime | High |

### Package Reviews (Priority 2-3)

| Task | Task doc | Dependencies | Estimated Effort |
|------|------|--------------|------------------|
| Plugin Loader | `tasks/implement/3-review-pkg-plugin-loader.md` | Core API | Medium |
| Plugins Review | `tasks/implement/3-review-pkg-plugins.md` | Plugin Loader | Medium |
| Sample Plugins | `tasks/implement/3-review-pkg-sample-plugins.md` | Plugins | Low |
| Store Review | `tasks/implement/3-review-pkg-store.md` | Core API, VTab | High |
| Sync Review | `tasks/implement/3-review-pkg-sync.md` | Store | High |
| Sync Client | `tasks/implement/3-review-pkg-sync-client.md` | Sync | Medium |
| Sync Coordinator | `tasks/implement/3-review-pkg-sync-coordinator.md` | Sync | Medium |
| Quoomb Web | `tasks/implement/3-review-pkg-quoomb-web.md` | All | High |
| VS Code | `tasks/implement/3-review-pkg-vscode.md` | Core API | Medium |
| Tools Review | `tasks/implement/3-review-pkg-tools.md` | Core API | Low |
| Isolation Review | `tasks/implement/3-review-pkg-isolation.md` | VTab | Medium |

### Cross-Cutting Reviews (Priority 2)

| Task | Task doc | Dependencies | Estimated Effort |
|------|------|--------------|------------------|
| Documentation | `tasks/implement/3-review-documentation.md` | All | Medium |
| Error Handling | `tasks/implement/3-review-error-handling.md` | All | Medium |
| Performance | `tasks/implement/3-review-performance.md` | All | Medium |
| Integration | `tasks/implement/3-review-integration-boundaries.md` | All core | High |
| Testing | `tasks/implement/3-review-testing-strategy.md` | All | Medium |

## 2. Recommended Execution Order

### Phase 1: Foundation Reviews

Execute in parallel where possible:

1. **Types & Utilities** (parallel)
   - `3-review-core-types.md`
   - `3-review-core-utilities.md`

2. **Schema** (can run with above)
   - `3-review-core-schema.md`

### Phase 2: Core Pipeline Reviews

Execute sequentially (dependencies exist):

3. **Parser** (first in pipeline)
   - `3-review-core-parser.md`

4. **Planner** (depends on parser)
   - `3-review-core-planner.md`

5. **Optimizer** (depends on planner)
   - `3-review-core-optimizer.md`

6. **Runtime** (depends on optimizer)
   - `3-review-core-runtime.md`

### Phase 3: Data Layer Reviews

Can run in parallel with Phase 2:

7. **VTab** (depends on schema)
   - `3-review-core-vtab.md`

8. **Functions** (depends on types)
   - `3-review-core-functions.md`

### Phase 4: API & Integration Reviews

After core reviews:

9. **Core API** (depends on all core)
   - `3-review-core-api.md`

10. **Integration Boundaries** (depends on all core)
    - `3-review-integration-boundaries.md`

### Phase 5: Package Reviews

After core reviews:

11. **Plugin System** (sequential)
    - `3-review-pkg-plugin-loader.md`
    - `3-review-pkg-plugins.md`
    - `3-review-pkg-sample-plugins.md`

12. **Storage & Sync** (sequential)
    - `3-review-pkg-store.md`
    - `3-review-pkg-sync.md`
    - `3-review-pkg-sync-client.md`
    - `3-review-pkg-sync-coordinator.md`

13. **Applications** (parallel)
    - `3-review-pkg-quoomb-web.md`
    - `3-review-pkg-vscode.md`
    - `3-review-pkg-tools.md`
    - `3-review-pkg-isolation.md`

### Phase 6: Cross-Cutting Reviews

After all component reviews:

14. **Quality & Process** (parallel)
    - `3-review-documentation.md`
    - `3-review-error-handling.md`
    - `3-review-testing-strategy.md`
    - `3-review-performance.md`

## 3. Execution Guidelines

### Before Starting a Review

1. **Read dependent reviews first** if completed
2. **Verify file locations** match current codebase
3. **Check for recent changes** that may affect review
4. **Set up necessary tooling** (profiling, testing, etc.)

### During Review

1. **Follow the TODO list** in each review document
2. **Document findings** as you go
3. **Create issues/tickets** for identified problems
4. **Write tests** before fixing issues where possible
5. **Update documentation** as needed

### After Review

1. **Update review document** with findings
2. **Mark completed TODOs** 
3. **Create follow-up tasks** for unresolved items
4. **Report blockers** to dependent reviews
5. **Move to next review** per schedule

## 4. Review Checklist Template

For each review, verify:

- [ ] All specified files reviewed
- [ ] DRY violations documented
- [ ] Large functions identified
- [ ] Error handling assessed
- [ ] Test coverage gaps identified
- [ ] Documentation gaps identified
- [ ] Refactoring candidates listed
- [ ] TODO list updated with findings
- [ ] Follow-up tasks created

## 5. Risk Areas

### High Risk

1. **Optimizer Rules** - Risk of infinite loops, incorrect optimization
2. **MVCC Isolation** - Risk of data consistency issues
3. **Async Error Handling** - Risk of swallowed errors
4. **Resource Management** - Risk of leaks

### Medium Risk

1. **Type Coercion** - Risk of incorrect conversions
2. **SQL Compatibility** - Risk of divergence from SQLite
3. **Transaction Handling** - Risk of incorrect isolation

### Lower Risk

1. **Documentation** - Risk of staleness
2. **Test Coverage** - Risk of gaps
3. **Performance** - Risk of regression

## 6. Coordination Points

### Blocking Dependencies

- Planner review blocked until Parser review identifies AST contracts
- Optimizer review blocked until Planner review identifies plan node contracts
- Runtime review blocked until Optimizer review identifies optimization guarantees

### Non-Blocking Information Flow

- Types review informs all other reviews
- Error handling review informs all implementation changes
- Testing strategy review informs all test writing

### Integration Points

- Integration boundaries review should synthesize findings from all core reviews
- Performance review should incorporate profiling data from all components
- Documentation review should reflect API changes from all reviews

## 7. Success Criteria

### Per-Review Success

- All TODOs addressed or deferred with rationale
- Test coverage improved for reviewed area
- Documentation updated for reviewed area
- No critical bugs introduced

### Overall Success

- All 27 review tasks completed
- Critical issues addressed
- Test coverage significantly improved
- Documentation comprehensive
- Performance benchmarks established
- Integration boundaries well-defined

## 8. Resource Allocation

### Recommended Focus Time

| Review Category | Hours per Review |
|-----------------|------------------|
| Core Pipeline (Parser, Planner, Optimizer, Runtime) | 8-12 |
| Core Support (Types, Schema, VTab, Functions) | 4-8 |
| Packages | 2-6 |
| Cross-Cutting | 4-6 |

### Total Estimated Effort

- Core reviews: ~60-80 hours
- Package reviews: ~30-50 hours
- Cross-cutting reviews: ~20-30 hours
- **Total: ~110-160 hours**

## 9. Progress Tracking

Use this section to track progress:

### Phase 1: Foundation
- [ ] Types Review
- [ ] Utilities Review
- [ ] Schema Review

### Phase 2: Core Pipeline
- [ ] Parser Review
- [ ] Planner Review
- [ ] Optimizer Review
- [ ] Runtime Review

### Phase 3: Data Layer
- [ ] VTab Review
- [ ] Functions Review

### Phase 4: API & Integration
- [ ] Core API Review
- [ ] Integration Boundaries Review

### Phase 5: Packages
- [ ] Plugin Loader Review
- [ ] Plugins Review
- [ ] Sample Plugins Review
- [ ] Store Review
- [ ] Sync Review
- [ ] Sync Client Review
- [ ] Sync Coordinator Review
- [ ] Quoomb Web Review
- [ ] VS Code Review
- [ ] Tools Review
- [ ] Isolation Review

### Phase 6: Cross-Cutting
- [ ] Documentation Review
- [ ] Error Handling Review
- [ ] Testing Strategy Review
- [ ] Performance Review
