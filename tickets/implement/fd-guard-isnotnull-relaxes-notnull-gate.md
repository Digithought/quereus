---
description: Relax the NOT-NULL gate in `extractPartialUniqueGuardedFds` so a nominally nullable UC column is admitted when the partial predicate contains a matching `col IS NOT NULL` conjunct. The guarded FD `K → others | P` is then sound because the predicate itself forces those columns non-NULL inside the partial scope.
prereq:
files:
  - packages/quereus/src/planner/analysis/partial-unique-extraction.ts
  - packages/quereus/test/optimizer/conditional-fds.spec.ts
  - packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic
---

## Goal

Today `partial-unique-extraction.ts` line 60 unconditionally rejects partial UCs
whose key columns are nominally nullable on the table. That mirrors the
non-partial NOT-NULL gate in `relationTypeFromTableSchema`, but it is too
strict for partial UCs: when the partial predicate `P` includes
`col IS NOT NULL` for the UC column, the column *is* effectively non-NULL
inside the partial scope, so the FD `K → others | P` is still sound. The
recognizer already encodes `IS NOT NULL` as `{ kind: 'is-null', column, negated: true }`,
so the bookkeeping is already in place — just the gate needs to consult it.

## Change

In `extractPartialUniqueGuardedFds`:

1. Recognize the guard clauses first (move `recognizeGuardClauses` above the
   gate check, or just reorder).
2. Build the set of columns that the predicate forces non-NULL:
   ```
   nonNullByPredicate = { c.column for each clause c
                         where c.kind === 'is-null' && c.negated === true }
   ```
3. Apply the gate per UC column: admit when
   `tableSchema.columns[idx]?.notNull === true` **or** `nonNullByPredicate.has(idx)`.
4. If any UC column fails both checks → skip that UC (same as today).

Soundness: the FD only activates when a surrounding predicate entails *every*
guard clause, which includes the `IS NOT NULL` clause we relied on for the
gate. So discharge can never falsely activate an FD whose key column might be
NULL — if the predicate doesn't entail the `IS NOT NULL` clause, the FD stays
guarded.

Composite UCs: the predicate must have an `IS NOT NULL` conjunct for **every**
nullable UC column — the per-column check above gives exactly that, since
`uc.columns.every(...)` short-circuits as soon as any UC column fails.

## Tests

### Unit (`packages/quereus/test/optimizer/conditional-fds.spec.ts`)

Under the existing `describe('extractPartialUniqueGuardedFds', ...)` block, add:

- **Positive: nullable UC column admitted when `WHERE col IS NOT NULL`**
  ```ts
  it('admits nullable UC column when predicate has matching IS NOT NULL', () => {
    const schema = makeSchema(
      [makeColumn('id', true), makeColumn('email', false, TEXT_TYPE)],
      [{ columns: [1], predicate: un('IS NOT NULL', colExpr('email')) }],
    );
    const fds = extractPartialUniqueGuardedFds(schema);
    expect(fds).to.have.length(1);
    expect(fds[0].determinants).to.deep.equal([1]);
    expect(fds[0].dependents).to.deep.equal([0]);
  });
  ```

- **Positive: composite UC with IS NOT NULL on each nullable UC column**
  ```ts
  it('admits composite UC when every nullable UC column has its own IS NOT NULL conjunct', () => {
    const schema = makeSchema(
      [makeColumn('id', true), makeColumn('a', false), makeColumn('b', false)],
      [{
        columns: [1, 2],
        predicate: bin('AND',
          un('IS NOT NULL', colExpr('a')),
          un('IS NOT NULL', colExpr('b'))),
      }],
    );
    const fds = extractPartialUniqueGuardedFds(schema);
    expect(fds).to.have.length(1);
    expect(fds[0].determinants.sort()).to.deep.equal([1, 2]);
  });
  ```

- **Negative: IS NOT NULL on a different column does not relax the gate**
  ```ts
  it('rejects nullable UC column when IS NOT NULL names a different column', () => {
    const schema = makeSchema(
      [makeColumn('id', true), makeColumn('email', false, TEXT_TYPE), makeColumn('status', true, TEXT_TYPE)],
      [{ columns: [1], predicate: un('IS NOT NULL', colExpr('status')) }],
    );
    expect(extractPartialUniqueGuardedFds(schema)).to.have.length(0);
  });
  ```

- **Negative: composite UC with only one of two nullable columns covered**
  ```ts
  it('rejects composite UC when only one nullable UC column has IS NOT NULL', () => {
    const schema = makeSchema(
      [makeColumn('id', true), makeColumn('a', false), makeColumn('b', false)],
      [{
        columns: [1, 2],
        predicate: un('IS NOT NULL', colExpr('a')),
      }],
    );
    expect(extractPartialUniqueGuardedFds(schema)).to.have.length(0);
  });
  ```

- **Negative: `IS NULL` (non-negated) does not satisfy the gate**
  ```ts
  it('rejects nullable UC column when conjunct is IS NULL, not IS NOT NULL', () => {
    const schema = makeSchema(
      [makeColumn('id', true), makeColumn('email', false, TEXT_TYPE)],
      [{ columns: [1], predicate: un('IS NULL', colExpr('email')) }],
    );
    expect(extractPartialUniqueGuardedFds(schema)).to.have.length(0);
  });
  ```

Keep the existing `'rejects nullable UC column (NOT-NULL gate)'` test — it
uses `WHERE status = 'active'` over a nullable `c`, so the predicate does not
force `c` non-NULL and the test must still pass.

### Sqllogic (`packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic`)

Replace / augment section 7g. Today 7g asserts that a nullable UC column with
`WHERE status = 'active'` produces no key (count=3). That's still correct.
**Add a new section 7h** that pins the relaxation: nullable UC column with
`WHERE email IS NOT NULL` discharges as a key inside the scope.

```sql
-- 7h. Nullable UC column with IS NOT NULL guard: the partial predicate itself
-- forces the column non-NULL inside scope, so the guarded FD is sound and
-- DISTINCT should be eliminable when the filter discharges it.
create table p7h (id integer primary key, email text null);
create unique index ix_p7h on p7h(email) where email is not null;
insert into p7h values (1, 'a@x');
insert into p7h values (2, 'b@x');
insert into p7h values (3, null);

-- Inside scope: every email is unique; DISTINCT must yield the same count
-- as without (correctness must hold whether or not the optimizer eliminated
-- DISTINCT). Two non-null rows.
select count(*) as n from (select distinct email from p7h where email is not null);
→ [{"n":2}]

-- Negative: without the IS NOT NULL filter, NULL is part of the result set;
-- correctness must remain — three distinct values including NULL.
select count(*) as n from (select distinct email from p7h);
→ [{"n":3}]

drop table p7h;
```

(7g remains unchanged — that still exercises the `status = 'active'` case
where the predicate does NOT relax the gate.)

## TODO

- Edit `extractPartialUniqueGuardedFds` in
  `packages/quereus/src/planner/analysis/partial-unique-extraction.ts`:
  - Move clause recognition (`recognizeGuardClauses`) above the NOT-NULL
    gate.
  - Compute `nonNullByPredicate: Set<number>` from clauses where
    `kind === 'is-null'` and `negated === true`.
  - Replace the blanket gate with: admit each UC column if
    `column.notNull === true` or `nonNullByPredicate.has(idx)`.
  - Update the file header comment block: drop "IS-NOT-NULL discharge for
    nominally-nullable UC columns" from the out-of-scope list (it's now
    handled); refresh the NOT-NULL gate doc-comment to describe the
    relaxation.
- Add the five unit tests above to
  `packages/quereus/test/optimizer/conditional-fds.spec.ts`.
- Add section 7h to
  `packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic`.
- Run from repo root, streaming output:
  - `yarn workspace @quereus/quereus run lint 2>&1 | tee /tmp/lint.log; tail -n 40 /tmp/lint.log`
  - `yarn test 2>&1 | tee /tmp/test.log; tail -n 100 /tmp/test.log`
  (Skip `yarn test:store` — orthogonal to FD analysis.)
- Hand off to review with a brief note on what was changed and any
  surprises encountered during testing.
