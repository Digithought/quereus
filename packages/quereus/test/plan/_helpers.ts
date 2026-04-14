import { Database } from '../../src/core/database.js';

export interface PlanRow {
	id: number;
	parent_id: number | null;
	op: string;
	node_type: string;
	detail: string;
	object_name: string | null;
}

export async function planRows(db: Database, sql: string): Promise<PlanRow[]> {
	const rows: PlanRow[] = [];
	for await (const r of db.eval(
		"SELECT id, parent_id, op, node_type, detail, object_name FROM query_plan(?)", [sql]
	)) {
		rows.push(r as PlanRow);
	}
	return rows;
}

export async function planOps(db: Database, sql: string): Promise<string[]> {
	const ops: string[] = [];
	for await (const r of db.eval("SELECT op FROM query_plan(?)", [sql])) {
		ops.push((r as { op: string }).op);
	}
	return ops;
}

export async function planNodeTypes(db: Database, sql: string): Promise<string[]> {
	const types: string[] = [];
	for await (const r of db.eval("SELECT node_type FROM query_plan(?)", [sql])) {
		types.push((r as { node_type: string }).node_type);
	}
	return types;
}

export async function allRows<T>(db: Database, sql: string): Promise<T[]> {
	const rows: T[] = [];
	for await (const r of db.eval(sql)) rows.push(r as T);
	return rows;
}

export function isDescendantOf(rows: PlanRow[], childId: number, ancestorId: number): boolean {
	let current = childId;
	const visited = new Set<number>();
	while (true) {
		if (visited.has(current)) return false;
		visited.add(current);
		const row = rows.find(r => r.id === current);
		if (!row || row.parent_id === null) return false;
		if (row.parent_id === ancestorId) return true;
		current = row.parent_id;
	}
}
