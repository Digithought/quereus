import type { SqlValue } from '@quereus/quereus';

/**
 * Format rows as CSV text with proper escaping.
 * Values containing commas, quotes, or newlines are quoted; embedded quotes are doubled.
 */
export function formatRowsAsCSV(rows: Record<string, SqlValue>[]): string {
	if (rows.length === 0) return '';

	const headers = Object.keys(rows[0]);
	const csvRows = [
		headers.join(','),
		...rows.map(row =>
			headers.map(header => {
				const value = row[header];
				if (value === null) return '';
				const str = String(value);
				if (str.includes(',') || str.includes('"') || str.includes('\n')) {
					return `"${str.replace(/"/g, '""')}"`;
				}
				return str;
			}).join(',')
		)
	];

	return csvRows.join('\n');
}
