# Quereus Plan Display Improvements

## Summary

The Quereus query plan display system has been significantly improved to provide:

1. **Concise, tree-like plan visualization** (default)
2. **Command line argument support** instead of environment variables
3. **Selective node expansion** for detailed inspection
4. **Multiple display formats** for different use cases

## New Features

### 1. Concise Plan Display (Default)

The new default plan format shows a clean tree structure with just the essential information:

```
Query Plan:
└─ Block#9: 1 statements [cost: 0.0002, total: 8.8e-8] {readonly: true}
    └─ Project#8: SELECT 1 AS result [cost: 0.01, total: 0.0002] {readonly: true}
        ├─ SingleRow#0: dual [cost: 0.01, total: 0.01] {readonly: true}
        └─ Literal#7: 1 [cost: 0.001, total: 0.001] {readonly: true}
```

**Features:**
- Tree-like structure with connection lines
- Node type and ID for reference
- Concise descriptions using `node.toString()`
- Cost information (estimated and total)
- Physical properties when available (rows, ordering, readonly status)
- Helpful tip about expanding specific nodes

### 2. Plan Summary

One-line execution path for quick understanding:

```
Execution Path: Block(1 statements) → Project(SELECT 1 AS result) → SingleRow(dual)
```

### 3. Command Line Arguments

Replace problematic environment variables with intuitive command line arguments:

| Argument | Description |
|----------|-------------|
| `--show-plan` | Show concise query plan on test failures |
| `--plan-summary` | Show one-line execution path summary |
| `--plan-full-detail` | Show full detailed query plan (JSON format) |
| `--expand-nodes node1,node2,...` | Expand specific nodes in concise plan |
| `--max-plan-depth N` | Limit plan display to N levels deep |
| `--show-program` | Show instruction program |
| `--show-trace` | Show execution trace |
| `--show-stack` | Show full stack traces |
| `--verbose` | Show execution progress |

### 4. Selective Node Expansion

Instead of overwhelming output, users can expand specific nodes:

```bash
# First, see the concise plan to identify node IDs
yarn test -- --show-plan

# Then expand specific nodes for detail
yarn test -- --expand-nodes "Block#9,Project#8"
```

When expanded, nodes show their logical properties:

```
└─ Project#8: SELECT 1 AS result [cost: 0.01, total: 0.0002] {readonly: true}
    ┌─ Logical Properties:
    │  {
    │    "projections": [
    │      {
    │        "expression": "1", 
    │        "alias": "result"
    │      }
    │    ]
    └─ }
```

## Usage Examples

### Basic Development Workflow

```bash
# Quick overview of plan structure
yarn test -- --plan-summary

# See detailed tree for debugging
yarn test -- --show-plan

# Deep dive into specific nodes
yarn test -- --show-plan --expand-nodes "node1,node2"

# Full diagnostic information
yarn test -- --show-plan --show-program --show-trace --verbose
```

### Backwards Compatibility

Environment variables are still supported for compatibility:

```bash
export QUEREUS_TEST_SHOW_PLAN=true
yarn test
```

But command line arguments are preferred:

```bash
yarn test -- --show-plan
```

## Implementation Details

### Core Components

1. **`formatPlanTree()`** - Creates the concise tree representation
2. **`formatPlanSummary()`** - Generates one-line execution paths
3. **`serializePlanTreeWithOptions()`** - Unified plan formatting entry point
4. **Command line parser** - Replaces environment variable system
5. **Enhanced Database.getDebugPlan()** - Supports formatting options

### Key Improvements

- **Readability**: Tree structure with connection lines makes plan hierarchy clear
- **Efficiency**: Only expand details when needed, avoiding information overload
- **Flexibility**: Multiple formats for different debugging scenarios
- **Usability**: Command line arguments work reliably with test runners
- **Maintainability**: Clean separation between concise and detailed formatting

### Design Principles

- **Progressive Disclosure**: Start with overview, drill down as needed
- **Visual Hierarchy**: Tree structure shows relationships clearly  
- **Essential Information First**: Show what matters most at each level
- **Consistent Formatting**: Standardized node display patterns
- **Tool Integration**: Works seamlessly with existing test infrastructure

## Migration Notes

For existing users:

1. **Environment variables still work** but are deprecated
2. **Plan output is now concise by default** - use `--plan-full-detail` for old format
3. **New command line syntax**: `yarn test -- --show-plan` (note the `--`)
4. **Node expansion workflow**: Get node IDs from concise plan, then expand specific ones

This improvement makes debugging complex queries much more approachable while preserving access to detailed information when needed.