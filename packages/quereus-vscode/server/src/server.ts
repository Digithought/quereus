/**
 * LSP server entry point — thin wiring layer.
 * All handler logic lives in handlers.ts for testability.
 */
import {
	createConnection,
	ProposedFeatures,
	TextDocuments,
	InitializeParams,
	SemanticTokensParams,
	SemanticTokens,
	CompletionItem,
	InitializeResult,
	TextDocumentSyncKind,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { Parser as ParserType, Database as DatabaseType } from '@quereus/quereus';
import { registerCommands, type SchemaSnapshot } from './commands.js';
import {
	SQL_KEYWORDS,
	tokenTypes,
	getCompletions,
	computeDiagnostics,
	tokenize,
	buildSemanticTokens,
} from './handlers.js';

type QuereusModule = typeof import('@quereus/quereus');
let quereusModPromise: Promise<QuereusModule> | null = null;
function loadQuereus(): Promise<QuereusModule> {
	if (!quereusModPromise) quereusModPromise = import('@quereus/quereus');
	return quereusModPromise;
}

const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let db: DatabaseType | null = null;
let externalSchema: SchemaSnapshot | null = null;

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
				full: true,
			},
		},
	};
});

async function validate(doc: TextDocument): Promise<void> {
	const mod = await loadQuereus();
	const diagnostics = computeDiagnostics(doc.getText(), mod.Parser as unknown as new () => ParserType);
	connection.sendDiagnostics({ uri: doc.uri, diagnostics });
}

documents.onDidOpen((e: { document: TextDocument }): void => { void validate(e.document); });
documents.onDidChangeContent((change: { document: TextDocument }): void => { void validate(change.document); });

connection.onCompletion((): CompletionItem[] => {
	return getCompletions(db, externalSchema, SQL_KEYWORDS);
});

connection.languages.semanticTokens.on((_params: SemanticTokensParams): SemanticTokens => {
	const doc = documents.get(_params.textDocument.uri);
	if (!doc) return { data: [] };
	const text = doc.getText();
	const lines = text.split('\n');
	const tokens = tokenize(text, SQL_KEYWORDS);
	return buildSemanticTokens(tokens, doc, lines);
});

documents.listen(connection);
connection.listen();
