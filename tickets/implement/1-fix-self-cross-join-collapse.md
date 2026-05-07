description: Fix self CROSS JOIN column-name collapse — disambiguate duplicates when ProjectNode would be elided
prereq:
files:
  packages/quereus/src/planner/building/select-modifiers.ts
  packages/quereus/src/planner/nodes/project-node.ts
  packages/quereus/test/logic/01.1-select-projection-extras.sqllogic
----

## Diagnosis

The bug is **not** about attribute IDs (those are already unique per scan). It's a **column-name disambiguation gap**:

For `select A.*, B.* from t1 as A cross join t1 as B` the planner produces:

```
JoinNode attrs=[a.a#18, a.b#19, b.a#20, b.b#21]
  AliasNode(A) attrs=[a.a#18, a.b#19]
    IndexScanNode/TableReferenceNode(t1) attrs=[t1.a#18, t1.b#19]
  AliasNode(B) attrs=[b.a#20, b.b#21]
    IndexScanNode/TableReferenceNode(t1) attrs=[t1.a#20, t1.b#21]
```

The four output attributes have distinct IDs and correct `relationName`s. The cross join itself produces the right cartesian (4 rows). What goes wrong is the **column names on the final relation**:

1. `buildStarProjections` (in `select-projections.ts`) expands `A.*` and `B.*` into 4 projections, each a `ColumnReferenceNode` with `expression.name = attr.name` (i.e. `a, b, a, b`), referencing source attribute IDs `[18, 19, 20, 21]` in order.
2. `isIdentityProjection` (in `select-modifiers.ts:199`) sees that the 4 projections map 1:1 to the 4 source attributes (same IDs, same names) and returns `true`. The `ProjectNode` is **elided** — `buildFinalProjections` returns `input` unchanged.
3. Without `ProjectNode`, the engine surfaces column names from the JoinNode's `getType()`, which is just `leftType.columns ++ rightType.columns` with no disambiguation → `[a, b, a, b]`.
4. Downstream consumers that key result rows by column name (test harness, callers building objects) collapse the duplicates and only retain one side. Hence the apparent "only one side's columns" symptom.

The first query (`A.a as la, B.a as ra`) works because explicit aliases (`la`, `ra`) cause `effectiveOutputName !== sourceAttr.name`, breaking the identity check and forcing a `ProjectNode` whose `outputTypeCache` already disambiguates duplicates with `:N` suffixes.

So the same problem also affects plain `select * from t1 as A cross join t1 as B`: it returns 4 rows but with column names `[a, b, a, b]` instead of `[a, b, a:1, b:1]`.

## Fix

Make `isIdentityProjection` return `false` when the source's attribute names contain duplicates (case-insensitive). When duplicates exist, disambiguation is required, so `ProjectNode` must run and apply its existing `:N` suffix rule. The cheap-pass-through optimization is preserved for the common case (single-source SELECT *, joins of differently-named tables, etc.).

```ts
// In isIdentityProjection, before the per-projection loop:
const seen = new Set<string>();
for (const a of sourceAttrs) {
    const key = a.name.toLowerCase();
    if (seen.has(key)) return false; // duplicates require ProjectNode disambiguation
    seen.add(key);
}
```

Place this guard after the length check at `select-modifiers.ts:205` and before the `for` loop at `:207`. This is the minimal change; the rest of the function is correct.

### Why not "fix it in JoinNode.getType"?

JoinNode could disambiguate names directly, but column names there are also used during plan formatting and may be referenced as part of relation types in other places. Pushing disambiguation into the place that already owns it (`ProjectNode.outputTypeCache`) is a smaller, more targeted change and matches the behavior already verified for `select *, * from t1` (single-source duplicate wildcard).

### Sanity-check the projection path

`ProjectNode.outputTypeCache` (`project-node.ts:47-83`) computes `baseName` from `proj.alias` → `colRef.expression.name` → `expressionToString(...)`, then appends `:N` for second+ occurrences. For `A.*, B.*` the four `ColumnReferenceNode`s carry `expression.name` = `a, b, a, b` (set by `buildStarProjections` at `select-projections.ts:80-83`), so the resulting names are `a, b, a:1, b:1`. ✓

`ProjectNode` preserves attribute IDs for `ColumnReferenceNode` projections (`project-node.ts:140-151`), so subsequent `ORDER BY A.a, B.a` still resolves through attribute IDs and is unaffected.

## Tests

Re-enable the two `-- TODO bug:` cases in `packages/quereus/test/logic/01.1-select-projection-extras.sqllogic` (uncomment the SQL and remove the `-- TODO bug:` comment lines, leaving the original section comment in place):

```sql
-- Qualified column refs over a self-join (cross join)
insert into t1 values (2, 'two');

select A.a as la, B.a as ra from t1 as A cross join t1 as B order by la, ra;
→ [{"la":1,"ra":1},{"la":1,"ra":2},{"la":2,"ra":1},{"la":2,"ra":2}]

select A.*, B.* from t1 as A cross join t1 as B order by A.a, B.a;
→ [{"a":1,"b":"one","a:1":1,"b:1":"one"},{"a":1,"b":"one","a:1":2,"b:1":"two"},{"a":2,"b":"two","a:1":1,"b:1":"one"},{"a":2,"b":"two","a:1":2,"b:1":"two"}]
```

The first case already passes (planner doesn't elide ProjectNode when explicit aliases differ from source names) but is preserved as regression coverage. The second case is the actual fix target.

Consider also adding (optional, in the same file) a plain `select * from t1 as A cross join t1 as B order by A.a, B.a` case expecting the same `:1`-suffixed shape — it exercises the same code path through the unqualified-wildcard expansion.

## TODO

- Edit `packages/quereus/src/planner/building/select-modifiers.ts`: add the duplicate-name guard at the top of `isIdentityProjection` (after the length check).
- Re-enable the two cases in `packages/quereus/test/logic/01.1-select-projection-extras.sqllogic` by removing the `-- TODO bug:` markers and uncommenting the SQL plus `→` expectations.
- Run `yarn build` from the repo root.
- Run `yarn test` from the repo root and confirm `01.1-select-projection-extras.sqllogic` passes along with the rest of the suite.
- (Optional) run `yarn lint` in `packages/quereus` if you've made wider edits.
