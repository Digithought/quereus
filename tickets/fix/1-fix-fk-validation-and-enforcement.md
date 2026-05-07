description: FK validation and enforcement gaps — mismatched arity / non-existent parent / non-natural column order accepted; cascade-RESTRICT chain, self-ref composite, parent DROP, DEFERRED auto-commit not enforced.
prereq:
files:
  packages/quereus/test/logic/41-fk-extended-targets.sqllogic
  packages/quereus/test/logic/41-fk-cascade-conflict-and-self-ref.sqllogic
  packages/quereus/src/planner/building/foreign-key-builder.ts
  packages/quereus/src/schema/manager.ts
----

## Problem

Foreign-key validation at CREATE and enforcement at DML / DDL have several gaps:

- **Arity mismatch at CREATE not rejected.** `foreign key (x) references mp(a, b)` with single child column referencing two parent columns is silently accepted.
- **FK to non-existent parent table not enforced** on insert. The CREATE accepts the dangling reference (acceptable per SQLite "deferred name resolution"), but a subsequent non-NULL child insert should still fail because the parent row cannot exist.
- **Multi-column FK with non-natural parent column order** (e.g. `references mp2(b, a)`) is not enforced — the column-pair lookup against the parent appears to ignore the declared order.
- **Cascade-then-RESTRICT chain across two FKs** is not detected. `update fa` should cascade to `fb`, which in turn is referenced by `fc` with default RESTRICT — the end-to-end update must atomically fail.
- **Self-referential composite FK** (`foreign key (pid, tag) references tree(id, tag)`) does not reject a row whose composite key has no matching parent tuple.
- **DROP TABLE of a FK-referenced parent** while child rows exist is not rejected.
- **Column-level `references t1` without column list + `deferrable initially deferred`** does not enforce the FK on auto-commit insert; the orphan row is accepted.

## Expected behavior

- CREATE TABLE rejects an FK whose child column count differs from the referenced parent column count.
- A non-NULL child insert against an FK whose parent table does not exist must error (parent table is missing → no possible match under MATCH SIMPLE on a non-NULL key).
- Multi-column FK lookups must use the declared parent column order, so `(x, y) references mp(b, a)` checks parent rows where `b = x and a = y`.
- A cascade that propagates into a row protected by a RESTRICT FK on another table must abort the whole statement atomically (no partial updates persisted).
- Composite self-referential FK enforces the same row-level lookup as any other FK, including against the same table.
- DROP TABLE on a parent referenced by extant child rows fails; DROP succeeds once children are removed (or dropped first).
- A `DEFERRABLE INITIALLY DEFERRED` column-level FK without an explicit column list still enforces at the deferred-check point — on auto-commit insert (no enclosing tx), the constraint is checked at statement end.

## Reproduction

All blocks below are currently commented `-- TODO bug:`. Uncomment to reproduce.

- `packages/quereus/test/logic/41-fk-extended-targets.sqllogic:123` — single-column child FK referencing two-column parent PK is accepted.
- `packages/quereus/test/logic/41-fk-extended-targets.sqllogic:137` — `c_orphan.p_id = 1` with `references no_such_parent(id)` does not error.
- `packages/quereus/test/logic/41-fk-extended-targets.sqllogic:153` — `(x=1, y=100) references mp2(b, a)` not rejected though no matching `(b=1, a=100)` parent exists.
- `packages/quereus/test/logic/41-fk-cascade-conflict-and-self-ref.sqllogic:48` — `update fa set id = 2` cascades to `fb` but RESTRICT from `fc` is not detected.
- `packages/quereus/test/logic/41-fk-cascade-conflict-and-self-ref.sqllogic:100` — `tree` self-FK accepts `(3, 1, 'b')` even though `(id=1, tag='b')` is absent.
- `packages/quereus/test/logic/41-fk-cascade-conflict-and-self-ref.sqllogic:128` — `drop table fk_drop_parent` accepted while `fk_drop_child` rows still reference it.
- `packages/quereus/test/logic/41-fk-cascade-conflict-and-self-ref.sqllogic:147` — `t2 (c integer null references t1 deferrable initially deferred, ...)` accepts `insert into t2 values (2, 4)` with no matching parent.

## Likely investigation areas

- `packages/quereus/src/planner/building/foreign-key-builder.ts` — arity validation, parent column-order propagation into the EXISTS lookup, dangling-parent handling for non-NULL children.
- `packages/quereus/src/schema/manager.ts` — referential-integrity bookkeeping for DROP TABLE; reverse-dependency lookup at drop time.
- Cascade emission path — must compose with downstream RESTRICT checks atomically; investigate how cascading updates compose with subsequent FK validation in the same statement.
- Deferred-FK handling — verify that auto-commit (implicit tx) still triggers the deferred check at statement end for column-level FKs declared without an explicit column list.
