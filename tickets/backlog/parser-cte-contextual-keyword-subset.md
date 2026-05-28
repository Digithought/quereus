description: CTE name/column list accepts a narrower contextual-keyword set than other identifier contexts — pre-existing inconsistency
files:
  packages/quereus/src/parser/parser.ts   # commonTableExpression (~line 291-302)
  packages/quereus/test/parser.spec.ts     # "documents narrower CTE set" characterization test
----

## Problem

Every identifier-accepting context in the parser (table names, column names, aliases, SET
clauses, ALTER actions, etc.) now shares the module-level `CONTEXTUAL_KEYWORDS` constant —
the 11-element set `['key','action','set','default','check','unique','references','on','cascade','restrict','like']`.

`commonTableExpression` is the lone exception. Its CTE name and CTE column list use a
*narrower, hand-written 7-element subset*:

```typescript
['key', 'action', 'set', 'default', 'check', 'unique', 'like']
```

It omits `references`, `on`, `cascade`, and `restrict`. The consequence is an observable,
asymmetric inconsistency: an unquoted `references` (or `on`/`cascade`/`restrict`) is accepted
as a table name but **rejected as a CTE name**:

```sql
select * from references;                              -- parses fine
with references as (select 1) select * from references; -- throws "Expected CTE name."
```

A characterization test in `parser.spec.ts`
(`rejects an unquoted reserved-but-table-legal keyword as a CTE name`) currently pins this
*current* (inconsistent) behavior so the divergence is visible and a future fix is a deliberate
test change rather than a silent one.

## Why it was left out of the DRY refactor

The `parser-contextual-keywords-constant` refactor was strictly behavior-preserving. Folding
the CTE set into `CONTEXTUAL_KEYWORDS` would *widen* what identifiers a CTE accepts — a behavior
change — so it was deliberately deferred rather than smuggled into a refactor.

## Decision needed

Is the narrower CTE set intentional (some reason `references`/`on`/`cascade`/`restrict` must stay
reserved specifically as CTE names), or is it an oversight from when the sets were copy-pasted?

If it is an oversight (most likely), the fix is to reference `CONTEXTUAL_KEYWORDS` at the two CTE
sites and update the characterization test to assert the keyword is now accepted. Verify against
SQLite's actual behavior for CTE naming with these keywords before changing.
