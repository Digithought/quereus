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
	Hover,
	InitializeResult,
	TextDocumentSyncKind
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { Parser as ParserType, Database as DatabaseType } from '@quereus/quereus';
import { registerCommands, type SchemaSnapshot } from './commands';

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

// Fallback keywords if engine exports are unavailable in this build context
const DEFAULT_KEYWORDS = [
	'WITH','RECURSIVE','SELECT','INSERT','UPDATE','DELETE','VALUES','CREATE','TABLE','VIEW','INDEX','ASSERTION','DROP','ALTER',
	'BEGIN','COMMIT','ROLLBACK','SAVEPOINT','RELEASE','PRAGMA','RETURNING','WHERE','FROM','GROUP','BY','HAVING','ORDER','LIMIT','OFFSET',
	'JOIN','INNER','LEFT','RIGHT','FULL','CROSS','OUTER','ON','USING','AS','DISTINCT','ALL','UNION','INTERSECT','EXCEPT','DIFF','NULL','TRUE','FALSE',
	'IS','NOT','AND','OR','XOR','IN','LIKE','BETWEEN','EXISTS','CASE','WHEN','THEN','ELSE','END','OVER','PARTITION','ROWS','RANGE','UNBOUNDED','PRECEDING','FOLLOWING','CURRENT',
	'COLLATE','DEFAULT','PRIMARY','KEY','CHECK','UNIQUE','FOREIGN','REFERENCES','CONSTRAINT','GENERATED','ALWAYS','STORED','VIRTUAL','INTO','USING','IF','TO','ADD','RENAME','SET','NO','ACTION','ABORT','FAIL','IGNORE','REPLACE'
];

function applySchemaSnapshot(snapshot: SchemaSnapshot): void {
	externalSchema = snapshot;
}

	connection.onInitialize(async (_params: InitializeParams): Promise<InitializeResult> => {
		const mod = await loadQuereus();
		db = new mod.Database();
		registerCommands(connection as unknown as any, db, applySchemaSnapshot);
		return {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			completionProvider: { triggerCharacters: [' ', '.', '(', ','] },
			hoverProvider: true,
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

documents.onDidOpen((e): void => { void validate(e.document); });
documents.onDidChangeContent((change): void => { void validate(change.document); });

connection.onCompletion((): CompletionItem[] => {
	// Keywords
	const items: CompletionItem[] = DEFAULT_KEYWORDS.map(k => ({ label: k, kind: CompletionItemKind.Keyword }));
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

connection.onHover((_params: unknown): Hover | null => {
	return null;
});

connection.languages.semanticTokens.on((_params: SemanticTokensParams): SemanticTokens => {
	const doc = documents.get(_params.textDocument.uri);
	if (!doc) return { data: [] };
	const text = doc.getText();
	const builder = new SemanticTokensBuilder();

	// Heuristic semantic tokens with proper comment/string handling
	const reWord = /\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
	const reFuncName = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g; // capture identifier before '('
	const reNumber = /\b\d+(?:\.\d+)?\b/g;
	// Do not allow strings to span newlines; support doubled quotes inside
	const reString = /'(?:''|[^'\r\n])*'|"(?:""|[^"\r\n])*"/g;
	const reLineComment = /--[^\n\r]*/g;
	const reBlockComment = /\/\*[\s\S]*?\*\//g;
	const reOperator = /==|!=|<>|<=|>=|\|\||[=<>+\-*\/%]/g;

	interface Span { start: number; end: number }
	interface Token { start: number; end: number; type: TokenTypeLabel }
	const stringSpans: Span[] = [];
	const commentSpans: Span[] = [];
	const tokens: Token[] = [];

	// 1) Capture comments first
	for (const m of text.matchAll(reLineComment)) {
		const start = m.index ?? 0; const end = start + m[0].length;
		commentSpans.push({ start, end });
		tokens.push({ start, end, type: 'comment' });
	}
	for (const m of text.matchAll(reBlockComment)) {
		const start = m.index ?? 0; const end = start + m[0].length;
		commentSpans.push({ start, end });
		tokens.push({ start, end, type: 'comment' });
	}

	function isInsideComment(offset: number): boolean {
		for (const s of commentSpans) if (offset >= s.start && offset < s.end) return true;
		return false;
	}

	// 2) Capture strings, but skip any starting inside comments
	for (const m of text.matchAll(reString)) {
		const start = m.index ?? 0; const end = start + m[0].length;
		if (isInsideComment(start)) continue;
		stringSpans.push({ start, end });
		tokens.push({ start, end, type: 'string' });
	}

	function isInsideSpans(offset: number): boolean {
		for (const s of stringSpans) if (offset >= s.start && offset < s.end) return true;
		for (const s of commentSpans) if (offset >= s.start && offset < s.end) return true;
		return false;
	}

	for (const m of text.matchAll(reWord)) {
		const idx = m.index ?? 0;
		if (isInsideSpans(idx)) continue;
		const word = m[1];
		if (DEFAULT_KEYWORDS.includes(word.toUpperCase())) {
			tokens.push({ start: idx, end: idx + word.length, type: 'keyword' });
		}
	}
	// Function identifiers (simple heuristic): identifier followed by '('
	for (const m of text.matchAll(reFuncName)) {
		const idx = m.index ?? 0;
		if (isInsideSpans(idx)) continue;
		const name = m[1];
		if (!DEFAULT_KEYWORDS.includes(name.toUpperCase())) {
			tokens.push({ start: idx, end: idx + name.length, type: 'function' });
		}
	}
	for (const m of text.matchAll(reNumber)) {
		const idx = m.index ?? 0;
		if (isInsideSpans(idx)) continue;
		tokens.push({ start: idx, end: idx + m[0].length, type: 'number' });
	}
	for (const m of text.matchAll(reOperator)) {
		const idx = m.index ?? 0;
		if (isInsideSpans(idx)) continue;
		tokens.push({ start: idx, end: idx + m[0].length, type: 'operator' });
	}

	// Sort tokens and drop overlaps to avoid out-of-order or duplicate ranges
	tokens.sort((a, b) => a.start - b.start || a.end - b.end);
	const emitted: Span[] = [];
	for (const t of tokens) {
		const last = emitted[emitted.length - 1];
		if (last && t.start < last.end) continue; // skip overlaps, prefer earlier token
		emitted.push({ start: t.start, end: t.end });
		pushRange(builder, doc, t.start, t.end - t.start, t.type);
	}

	return builder.build();
});

function pushRange(builder: SemanticTokensBuilder, doc: TextDocument, offset: number, length: number, type: TokenTypeLabel): void {
	const start = positionAt(doc, offset);
	const end = positionAt(doc, offset + length);
	const line = start.line;
	const char = start.character;
	if (end.line !== start.line) {
		// Split into per-line tokens when spanning multiple lines
		pushMultiline(builder, doc, offset, offset + length, type);
		return;
	}
	const len = end.character - start.character;
	builder.push(line, char, len, tokenTypeToIndex[type], 0);
}

function positionAt(doc: TextDocument, offset: number) {
	const text = doc.getText();
	let line = 0; let character = 0; let i = 0;
	while (i < offset && i < text.length) {
		const ch = text.charCodeAt(i++);
		if (ch === 10 /*\n*/) { line++; character = 0; } else { character++; }
	}
	return { line, character };
}

// removed: sanitizeForParsing - parser handles comments correctly and reports accurate locations

function pushMultiline(builder: SemanticTokensBuilder, doc: TextDocument, startOffset: number, endOffset: number, type: TokenTypeLabel): void {
	let start = positionAt(doc, startOffset);
	let end = positionAt(doc, endOffset);
	if (start.line === end.line) {
		const len = end.character - start.character;
		builder.push(start.line, start.character, len, tokenTypeToIndex[type], 0);
		return;
	}
	// First line
	const firstLineText = doc.getText().split('\n')[start.line] ?? '';
	const firstLen = firstLineText.length - start.character;
	builder.push(start.line, start.character, Math.max(0, firstLen), tokenTypeToIndex[type], 0);
	// Middle full lines
	for (let line = start.line + 1; line < end.line; line++) {
		const lineText = doc.getText().split('\n')[line] ?? '';
		if (lineText.length > 0) builder.push(line, 0, lineText.length, tokenTypeToIndex[type], 0);
	}
	// Last line
	if (end.character > 0) builder.push(end.line, 0, end.character, tokenTypeToIndex[type], 0);
}

documents.listen(connection);
connection.listen();


