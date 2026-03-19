description: findColumnPKDefinition only applies DESC direction for INTEGER primary keys
dependencies: none
files:
  packages/quereus/src/schema/table.ts
----
## Problem

In `findColumnPKDefinition` (table.ts:475-480), the `desc` flag is conditionally set based on column type:

```typescript
return Object.freeze(pkCols.map(col => ({
    index: col.originalIndex,
    desc: col.logicalType.name === 'INTEGER' && col.pkDirection === 'desc',
    autoIncrement: col.logicalType.name === 'INTEGER',
    collation: col.collation || 'BINARY'
})));
```

This means `CREATE TABLE t (name TEXT PRIMARY KEY DESC)` would have `desc: false` because the type is TEXT, not INTEGER. The declared sort direction is silently ignored for non-INTEGER columns.

Additionally, `autoIncrement` is set to `true` for all INTEGER PKs regardless of whether `AUTOINCREMENT` was actually declared. This could cause unexpected auto-increment behavior.

## Questions

- Is the INTEGER-only DESC behavior intentional for the key-based (no rowid) VTab design?
- Should `autoIncrement` only be set when explicitly declared?
- Does the VTab module infrastructure depend on these assumptions?

## TODO

- [ ] Clarify design intent for INTEGER-only DESC and auto-increment
- [ ] If unintentional: apply pkDirection for all types, not just INTEGER
- [ ] If unintentional: only set autoIncrement when explicitly declared
- [ ] Add test cases for DESC PRIMARY KEY on non-INTEGER columns
