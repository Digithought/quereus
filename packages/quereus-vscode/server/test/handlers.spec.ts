import { expect } from 'chai';
import { Database, Parser } from '@quereus/quereus';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CompletionItemKind } from 'vscode-languageserver/node';
import {
	SQL_KEYWORDS,
	getCompletions,
	computeDiagnostics,
	tokenize,
	buildSemanticTokens,
	sortAndMergeSpans,
	isInsideSortedSpans,
	toRange,
} from '../src/handlers.js';
import type { SchemaSnapshot } from '../../shared/types.js';

describe('getCompletions', () => {
	it('returns keyword completions with null db', () => {
		const items = getCompletions(null, null, SQL_KEYWORDS);
		expect(items.length).to.be.greaterThan(0);
		const selectItem = items.find(i => i.label === 'select');
		expect(selectItem).to.exist;
		expect(selectItem!.kind).to.equal(CompletionItemKind.Keyword);
	});

	it('includes table and column completions from db', async () => {
		const db = new Database();
		await db.exec('create table users (id integer primary key, name text)');
		const items = getCompletions(db, null, SQL_KEYWORDS);
		const tableItem = items.find(i => i.label === 'users' && i.kind === CompletionItemKind.Class);
		expect(tableItem).to.exist;
		const colItem = items.find(i => i.label === 'users.name');
		expect(colItem).to.exist;
		expect(colItem!.kind).to.equal(CompletionItemKind.Field);
	});

	it('includes external schema tables and functions', () => {
		const ext: SchemaSnapshot = {
			tables: [{ name: 'orders', schema: 'main', columns: ['id', 'total'] }],
			functions: [{ name: 'sum', numArgs: 1 }],
		};
		const items = getCompletions(null, ext, ['select']);
		const tableItem = items.find(i => i.label === 'orders');
		expect(tableItem).to.exist;
		const colItem = items.find(i => i.label === 'orders.total');
		expect(colItem).to.exist;
		const fnItem = items.find(i => i.label === 'SUM');
		expect(fnItem).to.exist;
		expect(fnItem!.kind).to.equal(CompletionItemKind.Function);
		expect(fnItem!.detail).to.equal('/1');
	});
});

describe('computeDiagnostics', () => {
	it('returns empty diagnostics for valid SQL', () => {
		const diags = computeDiagnostics('select 1', Parser);
		expect(diags).to.have.length(0);
	});

	it('returns error diagnostic for invalid SQL', () => {
		const diags = computeDiagnostics('select from where', Parser);
		expect(diags).to.have.length(1);
		expect(diags[0].source).to.equal('quereus');
		expect(diags[0].message).to.be.a('string').and.not.empty;
	});

	it('returns error diagnostic for incomplete SQL', () => {
		const diags = computeDiagnostics('select * from', Parser);
		expect(diags).to.have.length(1);
	});
});

describe('tokenize', () => {
	const kw = ['select', 'from', 'where', 'create', 'table', 'insert', 'into', 'values'];

	it('identifies keywords', () => {
		const tokens = tokenize('select * from users', kw);
		const keywords = tokens.filter(t => t.type === 'keyword');
		expect(keywords).to.have.length(2);
		expect(keywords.map(t => 'select * from users'.slice(t.start, t.end).toLowerCase()))
			.to.deep.equal(['select', 'from']);
	});

	it('identifies function calls', () => {
		const tokens = tokenize('select count(1) from t', kw);
		const fns = tokens.filter(t => t.type === 'function');
		expect(fns).to.have.length(1);
		expect('select count(1) from t'.slice(fns[0].start, fns[0].end)).to.equal('count');
	});

	it('identifies string literals', () => {
		const tokens = tokenize("select 'hello world'", kw);
		const strings = tokens.filter(t => t.type === 'string');
		expect(strings).to.have.length(1);
	});

	it('identifies numbers', () => {
		const tokens = tokenize('select 42, 3.14', kw);
		const nums = tokens.filter(t => t.type === 'number');
		expect(nums).to.have.length(2);
	});

	it('identifies line comments', () => {
		const tokens = tokenize('select 1 -- a comment', kw);
		const comments = tokens.filter(t => t.type === 'comment');
		expect(comments).to.have.length(1);
	});

	it('identifies block comments', () => {
		const tokens = tokenize('select /* block */ 1', kw);
		const comments = tokens.filter(t => t.type === 'comment');
		expect(comments).to.have.length(1);
	});

	it('skips keywords inside strings', () => {
		const tokens = tokenize("select 'select from'", kw);
		const keywords = tokens.filter(t => t.type === 'keyword');
		expect(keywords).to.have.length(1); // only the first select
	});

	it('skips keywords inside comments', () => {
		const tokens = tokenize('-- select from\nselect 1', kw);
		const keywords = tokens.filter(t => t.type === 'keyword');
		expect(keywords).to.have.length(1); // only the second select
	});

	it('identifies operators', () => {
		const tokens = tokenize('select 1 + 2', kw);
		const ops = tokens.filter(t => t.type === 'operator');
		expect(ops).to.have.length(1);
	});

	it('returns tokens in sorted order without overlaps', () => {
		const tokens = tokenize('select count(1) from users where id = 1', kw);
		for (let i = 1; i < tokens.length; i++) {
			expect(tokens[i].start).to.be.at.least(tokens[i - 1].end);
		}
	});
});

describe('buildSemanticTokens', () => {
	it('produces non-empty data for SQL text', () => {
		const text = 'select 1';
		const doc = TextDocument.create('file:///test.sql', 'sql', 1, text);
		const tokens = tokenize(text, SQL_KEYWORDS);
		const result = buildSemanticTokens(tokens, doc, text.split('\n'));
		expect(result.data).to.be.an('array');
		expect(result.data.length).to.be.greaterThan(0);
	});

	it('handles multiline text', () => {
		const text = 'select\n  1\nfrom\n  t';
		const doc = TextDocument.create('file:///test.sql', 'sql', 1, text);
		const tokens = tokenize(text, SQL_KEYWORDS);
		const result = buildSemanticTokens(tokens, doc, text.split('\n'));
		expect(result.data).to.be.an('array');
		expect(result.data.length).to.be.greaterThan(0);
	});
});

describe('sortAndMergeSpans', () => {
	it('returns empty for empty input', () => {
		expect(sortAndMergeSpans([])).to.deep.equal([]);
	});

	it('merges overlapping spans', () => {
		const merged = sortAndMergeSpans([{ start: 0, end: 5 }, { start: 3, end: 8 }]);
		expect(merged).to.deep.equal([{ start: 0, end: 8 }]);
	});

	it('keeps non-overlapping spans separate', () => {
		const merged = sortAndMergeSpans([{ start: 0, end: 3 }, { start: 5, end: 8 }]);
		expect(merged).to.have.length(2);
	});

	it('merges adjacent spans', () => {
		const merged = sortAndMergeSpans([{ start: 0, end: 5 }, { start: 5, end: 10 }]);
		expect(merged).to.deep.equal([{ start: 0, end: 10 }]);
	});
});

describe('isInsideSortedSpans', () => {
	const spans = [{ start: 5, end: 10 }, { start: 20, end: 25 }];

	it('returns true for offset inside a span', () => {
		expect(isInsideSortedSpans(7, spans)).to.be.true;
		expect(isInsideSortedSpans(22, spans)).to.be.true;
	});

	it('returns false for offset outside spans', () => {
		expect(isInsideSortedSpans(3, spans)).to.be.false;
		expect(isInsideSortedSpans(15, spans)).to.be.false;
		expect(isInsideSortedSpans(30, spans)).to.be.false;
	});

	it('returns true at span start, false at span end', () => {
		expect(isInsideSortedSpans(5, spans)).to.be.true;
		expect(isInsideSortedSpans(10, spans)).to.be.false;
	});
});

describe('toRange', () => {
	it('converts 1-indexed parser location to 0-indexed LSP range', () => {
		const range = toRange({ start: { line: 1, column: 1 }, end: { line: 1, column: 7 } });
		expect(range).to.deep.equal({
			start: { line: 0, character: 0 },
			end: { line: 0, character: 6 },
		});
	});
});
