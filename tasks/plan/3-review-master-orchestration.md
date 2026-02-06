---
description: Master orchestration for comprehensive Quereus project review
dependencies: none
priority: 3
---

# Quereus Comprehensive Review - Master Orchestration

This document orchestrates the comprehensive architectural, design, and code review of the Quereus project in preparation for release from beta.

## Review Philosophy

Each review task operates adversarially, assuming:
- Code may have defects until proven otherwise
- Tests may follow happy paths only
- Documentation may be stale
- DRY violations may exist
- Single responsibility may be violated
- Expressiveness may be sacrificed for imperative style

## Review Layers

### Layer 1: Planning (Current Phase)
Create detailed review plans for each subsystem. These plans identify:
- Specific files and functions to review
- Exact tests to write or expand
- Concrete refactoring candidates
- Documentation updates needed

### Layer 2: Implementation
Execute the review plans, producing:
- Code improvements and refactoring
- New and expanded tests
- Documentation corrections
- Defect fixes

### Layer 3: Verification
Verify that all review actions are complete:
- All tests pass
- Code quality standards met
- Documentation accurate
- No remaining defects

## Task Dependency Graph

```
                    ┌─────────────────────────────────────────────────────────────┐
                    │              Cross-Cutting Reviews                          │
                    │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
                    │  │  Testing    │  │Documentation│  │Performance  │         │
                    │  │  Strategy   │  │   Review    │  │   Review    │         │
                    │  └─────────────┘  └─────────────┘  └─────────────┘         │
                    │  ┌─────────────┐  ┌─────────────────────────────────┐      │
                    │  │Error Handling│  │  Integration Boundaries        │      │
                    │  │   Review    │  │  (depends on all others)        │      │
                    │  └─────────────┘  └─────────────────────────────────┘      │
                    └─────────────────────────────────────────────────────────────┘
                                              │
           ┌──────────────────────────────────┼──────────────────────────────────┐
           │                                  │                                  │
    ┌──────┴──────┐                    ┌──────┴──────┐                    ┌──────┴──────┐
    │    Core     │                    │   Packages  │                    │    Tools    │
    │  Subsystems │                    │             │                    │             │
    └──────┬──────┘                    └──────┬──────┘                    └──────┬──────┘
           │                                  │                                  │
    ┌──────┴──────────────────┐       ┌──────┴──────────────────┐       ┌──────┴──────┐
    │ Parser → Planner →      │       │ Store → Isolation →     │       │ Tools       │
    │ Optimizer → Runtime     │       │ Storage Plugins         │       │ VSCode      │
    │ Schema → VTab → Types   │       │                         │       │ Quoomb-web  │
    │ Functions → API         │       │ Sync → Sync-client →    │       │ Samples     │
    │ Utilities               │       │ Sync-coordinator        │       │             │
    │                         │       │ Plugin-loader           │       │             │
    └─────────────────────────┘       └─────────────────────────┘       └─────────────┘
```

## Review Tasks Summary

### Core Subsystems (10 tasks)
| Task | Subsystem | Key Focus |
|------|-----------|-----------|
| 3-review-core-parser | Parser | Lexer, parser, AST |
| 3-review-core-planner | Planner | Plan building, scopes, nodes |
| 3-review-core-optimizer | Optimizer | Rules, framework, analysis |
| 3-review-core-runtime | Runtime | Emitters, scheduler, context |
| 3-review-core-schema | Schema | Manager, tables, change events |
| 3-review-core-vtab | Virtual Tables | Interface, MemoryTable |
| 3-review-core-types | Type System | Logical types, temporal, JSON |
| 3-review-core-functions | Functions | Scalar, aggregate, window, JSON |
| 3-review-core-api | Core API | Database, Statement |
| 3-review-core-utilities | Utilities | Comparison, coercion, caching |

### Package Reviews (11 tasks)
| Task | Package | Key Focus |
|------|---------|-----------|
| 3-review-pkg-store | quereus-store | Abstract storage layer |
| 3-review-pkg-isolation | quereus-isolation | Transaction isolation |
| 3-review-pkg-plugins | Storage plugins | IndexedDB, LevelDB, SQLite, RN |
| 3-review-pkg-sync | quereus-sync | CRDT sync infrastructure |
| 3-review-pkg-sync-client | quereus-sync-client | Sync client |
| 3-review-pkg-sync-coordinator | sync-coordinator | Sync coordinator |
| 3-review-pkg-plugin-loader | plugin-loader | Plugin discovery/loading |
| 3-review-pkg-vscode | quereus-vscode | VS Code extension |
| 3-review-pkg-tools | planviz, CLI | Developer tools |
| 3-review-pkg-quoomb-web | quoomb-web | Browser SQL workbench |
| 3-review-pkg-sample-plugins | sample-plugins | Example plugins |

### Cross-Cutting Reviews (5 tasks)
| Task | Area | Key Focus |
|------|------|-----------|
| 3-review-testing-strategy | Testing | Coverage, quality, infrastructure |
| 3-review-documentation | Documentation | Accuracy, completeness |
| 3-review-integration-boundaries | Integration | Package boundaries, contracts |
| 3-review-error-handling | Errors | Handling patterns, messages |
| 3-review-performance | Performance | Hotspots, benchmarks |

## Review Standards

Each detailed review task must verify:

### Code Quality
- [ ] Single responsibility principle
- [ ] DRY (no repeated code)
- [ ] Expressiveness over imperative
- [ ] Proper const declarations
- [ ] No monkey-patching
- [ ] No swallowed exceptions
- [ ] No inline imports
- [ ] Proper type safety (no unnecessary `any`)

### Test Quality
- [ ] Not just happy paths
- [ ] Boundary conditions tested
- [ ] Error conditions tested
- [ ] Edge cases tested
- [ ] Tests are readable and maintainable
- [ ] Tests verify behavior, not implementation

### Documentation Quality
- [ ] Matches implementation
- [ ] Examples are correct
- [ ] Complete coverage
- [ ] Clear and readable

## Execution Strategy

1. **Parallel Execution**: Independent review tasks can run in parallel
2. **Dependency Order**: Respect task dependencies (e.g., store before plugins)
3. **Integration Last**: Integration boundary review runs after component reviews
4. **Incremental Delivery**: Each completed review produces actionable tasks

## Success Criteria

The comprehensive review is complete when:
1. All 27 planning tasks have been elaborated into implement tasks
2. All implement tasks have been executed
3. All tests pass
4. All documentation is accurate
5. No known defects remain
6. Code quality standards met throughout
7. System is ready for release from beta
