import {
	createConnection,
	ProposedFeatures,
	TextDocuments,
	Diagnostic,
	DiagnosticSeverity,
	InitializeParams,
	SemanticTokensParams,
	SemanticTokens,
	SemanticTokensBuilder,
	CompletionItem,
	CompletionItemKind,
	InitializeResult,
	TextDocumentSyncKind
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { Parser as ParserType, Database as DatabaseType } from '@quereus/quereus';
import { KEYWORDS } from '@quereus/quereus';
import { registerCommands, type SchemaSnapshot } from './commands';

/** Canonical keyword list derived from the engine's lexer. */
const SQL_KEYWORDS = Object.keys(KEYWORDS);

const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

// Lazy-load engine module (ESM) and initialize DB after initialize
type QuereusModule = typeof import('@quereus/quereus');
let quereusModPromise: Promise<QuereusModule> | null = null;
function loadQuereus(): Promise<QuereusModule> {
    if (!quereusModPromise) quereusModPromise = import('@quereus/quereus');
    return quereusModPromise;
}

let db: DatabaseType | null = null;
let externalSchema: SchemaSnapshot | null = null;

const tokenTypes = ['keyword','function','string','number','operator','variable','comment'] as const;
type TokenTypeLabel = typeof tokenTypes[number];
const tokenTypeToIndex: Record<TokenTypeLabel, number> = Object.fromEntries(tokenTypes.map((t, i) => [t, i])) as Record<TokenTypeLabel, number>;


function applySchemaSnapshot(snapshot: SchemaSnapshot): void {
	externalSchema = snapshot;
}

connection.onInitialize(async (_params: InitializeParams): Promise<InitializeResult> => {
	const mod = await loadQuereus();
	db = new mod.Database();
	registerCommands(connection, db, applySchemaSnapshot);
	return {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			completionProvider: { triggerCharacters: [' ', '.', '(', ','] },
			semanticTokensProvider: {
				legend: { tokenTypes: [...tokenTypes], tokenModifiers: [] },
				range: false,
				full: true
			}
		}
	};
});

function toRange(loc: { start: { line: number, column: number }, end: { line: number, column: number } }) {
	return {
		start: { line: loc.start.line - 1, character: loc.start.column - 1 },
		end: { line: loc.end.line - 1, character: loc.end.column - 1 }
	};
}

async function validate(doc: TextDocument): Promise<void> {
	const text = doc.getText();
	const diagnostics: Diagnostic[] = [];
	try {
		const mod = await loadQuereus();
		const parser: ParserType = new mod.Parser();
		parser.parseAll(text);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		// Prefer QuereusError line/column if present
		const line = (e as any)?.line as number | undefined;
		const column = (e as any)?.column as number | undefined;
		const loc = (e as any)?.loc as { start?: { line: number, column: number }, end?: { line: number, column: number } } | undefined;
		let range: { start: { line: number, character: number }, end: { line: number, character: number } };
		if (line !== undefined && column !== undefined) {
			const docLines = doc.getText().split('\n');
			const lineIdx = Math.max(0, Math.min(docLines.length - 1, line - 1));
			const maxChar = (docLines[lineIdx] ?? '').length;
			const charIdx = Math.max(0, Math.min(maxChar, column - 1));
			range = { start: { line: lineIdx, character: charIdx }, end: { line: lineIdx, character: Math.min(maxChar, charIdx + 1) } };
		} else if (loc?.start && loc?.end) {
			range = toRange({ start: loc.start, end: loc.end });
		} else {
			range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
		}
		diagnostics.push({
			severity: DiagnosticSeverity.Error,
			range,
			message,
			source: 'quereus'
		});
	}
	connection.sendDiagnostics({ uri: doc.uri, diagnostics });
}

documents.onDidOpen((e: { document: TextDocument }): void => { void validate(e.document); });
documents.onDidChangeContent((change: { document: TextDocument }): void => { void validate(change.document); });

connection.onCompletion((): CompletionItem[] => {
	// Keywords
	const items: CompletionItem[] = SQL_KEYWORDS.map(k => ({ label: k, kind: CompletionItemKind.Keyword }));
	// Tables and columns (from in-memory db)
	for (const tbl of (db?.schemaManager.getMainSchema().getAllTables() ?? [])) {
		items.push({ label: tbl.name, kind: CompletionItemKind.Class, detail: tbl.schemaName });
		for (const col of tbl.columns) {
			items.push({ label: `${tbl.name}.${col.name}`, kind: CompletionItemKind.Field });
		}
	}
	// External snapshot tables/functions
	if (externalSchema) {
		for (const tbl of externalSchema.tables) {
			items.push({ label: tbl.name, kind: CompletionItemKind.Class, detail: tbl.schema });
			for (const col of tbl.columns) {
				items.push({ label: `${tbl.name}.${col}`, kind: CompletionItemKind.Field });
			}
		}
		for (const fn of externalSchema.functions) {
			items.push({ label: fn.name.toUpperCase(), kind: CompletionItemKind.Function, detail: `/${fn.numArgs}` });
		}
	}
	return items;
});

interface Span { start: number; end: number }

function sortAndMergeSpans(spans: Span[]): Span[] {
	if (spans.length <= 1) return spans;
	spans.sort((a, b) => a.start - b.start);
	const merged: Span[] = [{ ...spans[0] }];
	for (let i = 1; i < spans.length; i++) {
		const last = merged[merged.length - 1];
		if (spans[i].start <= last.end) {
			last.end = Math.max(last.end, spans[i].end);
		} else {
			merged.push({ ...spans[i] });
		}
	}
	return merged;
}

function isInsideSortedSpans(offset: number, spans: Span[]): boolean {
	let lo = 0, hi = spans.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (offset < spans[mid].start) hi = mid - 1;
		else if (offset >= spans[mid].end) lo = mid + 1;
		else return true;
	}
	return false;
}

connection.languages.semanticTokens.on((_params: SemanticTokensParams): SemanticTokens => {
	const doc = documents.get(_params.textDocument.uri);
	if (!doc) return { data: [] };
	const text = doc.getText();
	const lines = text.split('\n');
	const builder = new SemanticTokensBuilder();

	const reWord = /\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
	const reFuncName = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
	const reNumber = /\b\d+(?:\.\d+)?\b/g;
	const reString = /'(?:''|[^'\r\n])*'|"(?:""|[^"\r\n])*"/g;
	const reLineComment = /--[^\n\r]*/g;
	const reBlockComment = /\/\*[\s\S]*?\*\//g;
	const reOperator = /==|!=|<>|<=|>=|\|\||[=<>+\-*\/%]/g;

	interface Token { start: number; end: number; type: TokenTypeLabel }
	const commentSpansRaw: Span[] = [];
	const tokens: Token[] = [];

	// 1) Capture comments
	for (const m of text.matchAll(reLineComment)) {
		const start = m.index ?? 0; const end = start + m[0].length;
		commentSpansRaw.push({ start, end });
		tokens.push({ start, end, type: 'comment' });
	}
	for (const m of text.matchAll(reBlockComment)) {
		const start = m.index ?? 0; const end = start + m[0].length;
		commentSpansRaw.push({ start, end });
		tokens.push({ start, end, type: 'comment' });
	}
	const commentSpans = sortAndMergeSpans(commentSpansRaw);

	// 2) Capture strings, skip any starting inside comments
	const stringSpansRaw: Span[] = [];
	for (const m of text.matchAll(reString)) {
		const start = m.index ?? 0; const end = start + m[0].length;
		if (isInsideSortedSpans(start, commentSpans)) continue;
		stringSpansRaw.push({ start, end });
		tokens.push({ start, end, type: 'string' });
	}
	const excludeSpans = sortAndMergeSpans([...commentSpans, ...stringSpansRaw]);

	// 3) Keywords, functions, numbers, operators — skip tokens inside comments/strings
	for (const m of text.matchAll(reWord)) {
		const idx = m.index ?? 0;
		if (isInsideSortedSpans(idx, excludeSpans)) continue;
		const word = m[1];
		if (SQL_KEYWORDS.includes(word.toLowerCase())) {
			tokens.push({ start: idx, end: idx + word.length, type: 'keyword' });
		}
	}
	for (const m of text.matchAll(reFuncName)) {
		const idx = m.index ?? 0;
		if (isInsideSortedSpans(idx, excludeSpans)) continue;
		const name = m[1];
		if (!SQL_KEYWORDS.includes(name.toLowerCase())) {
			tokens.push({ start: idx, end: idx + name.length, type: 'function' });
		}
	}
	for (const m of text.matchAll(reNumber)) {
		const idx = m.index ?? 0;
		if (isInsideSortedSpans(idx, excludeSpans)) continue;
		tokens.push({ start: idx, end: idx + m[0].length, type: 'number' });
	}
	for (const m of text.matchAll(reOperator)) {
		const idx = m.index ?? 0;
		if (isInsideSortedSpans(idx, excludeSpans)) continue;
		tokens.push({ start: idx, end: idx + m[0].length, type: 'operator' });
	}

	// Sort tokens and drop overlaps
	tokens.sort((a, b) => a.start - b.start || a.end - b.end);
	const emitted: Span[] = [];
	for (const t of tokens) {
		const last = emitted[emitted.length - 1];
		if (last && t.start < last.end) continue;
		emitted.push({ start: t.start, end: t.end });
		pushRange(builder, doc, t.start, t.end - t.start, t.type, lines);
	}

	return builder.build();
});

function pushRange(builder: SemanticTokensBuilder, doc: TextDocument, offset: number, length: number, type: TokenTypeLabel, lines: string[]): void {
	const start = doc.positionAt(offset);
	const end = doc.positionAt(offset + length);
	if (end.line !== start.line) {
		pushMultiline(builder, doc, offset, offset + length, type, lines);
		return;
	}
	builder.push(start.line, start.character, end.character - start.character, tokenTypeToIndex[type], 0);
}

function pushMultiline(builder: SemanticTokensBuilder, doc: TextDocument, startOffset: number, endOffset: number, type: TokenTypeLabel, lines: string[]): void {
	const start = doc.positionAt(startOffset);
	const end = doc.positionAt(endOffset);
	if (start.line === end.line) {
		builder.push(start.line, start.character, end.character - start.character, tokenTypeToIndex[type], 0);
		return;
	}
	// First line
	const firstLen = (lines[start.line] ?? '').length - start.character;
	builder.push(start.line, start.character, Math.max(0, firstLen), tokenTypeToIndex[type], 0);
	// Middle full lines
	for (let line = start.line + 1; line < end.line; line++) {
		const lineLen = (lines[line] ?? '').length;
		if (lineLen > 0) builder.push(line, 0, lineLen, tokenTypeToIndex[type], 0);
	}
	// Last line
	if (end.character > 0) builder.push(end.line, 0, end.character, tokenTypeToIndex[type], 0);
}

documents.listen(connection);
connection.listen();


