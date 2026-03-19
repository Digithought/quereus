description: APPLY SCHEMA seed data silently NULLs boolean and Uint8Array values
dependencies: none
files:
  packages/quereus/src/runtime/emit/schema-declarative.ts
----
In `emitApplySchema`, seed data values are interpolated into INSERT SQL (lines 147-155). The type mapping handles `null`, `string`, `number`, and `bigint` but the fallthrough for any other type (including `boolean` and `Uint8Array`) produces `'NULL'`, silently discarding the value.

`SqlValue = string | number | bigint | boolean | Uint8Array | null` — so two valid SqlValue types are silently lost.

**Fix approach**: Add handling for boolean (convert to 0/1) and Uint8Array (convert to hex literal `X'...'`).

```typescript
typeof v === 'boolean' ? (v ? '1' : '0') :
v instanceof Uint8Array ? `X'${Buffer.from(v).toString('hex')}'` :
```

Note: `Buffer.from()` is Node-specific. For cross-platform, use a utility that works in browser/RN too.

## TODO
- Add boolean → 0/1 mapping in seed data interpolation
- Add Uint8Array → hex literal mapping (cross-platform)
- Add test case with boolean and blob seed data
